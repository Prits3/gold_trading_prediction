"""Continuous learning loop:

  collect -> features -> issue forecasts -> wait for outcomes -> score matured forecasts -> train/evaluate challengers
  -> retain or promote -> repeat

Rules that keep the loop honest (see PROMOTION_RULE for the user-facing text):
  * Only MATURED labels train anything (a 20-session forecast is not a training example until its target session exists).
  * Forecasts are written to an append-only ledger before their outcomes exist and are never edited.
  * There is no "untouched test period" reused day after day. Walk-forward results are DEVELOPMENT evidence. The only
    untouched evidence is forward shadow forecasts, judged after their targets mature.
  * A challenger needs development evidence AND forward evidence, corrected for the number of challengers compared.
  * Insufficient evidence retains the incumbent. Any champion can be rolled back, automatically or by hand.
Live price ticks never train anything.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from . import db, drivers, ledger, nowcast, registry
from . import research_drivers as rd
from .features import FEATURE_NAMES
from .model import target_date as session_target_date

NY = "America/New_York"
LEVEL = 0.80
MIN_IMPROVEMENT = 0.02          # candidate must cut MAE by >= 2% vs the unchanged price AND vs the incumbent (development)
ALPHA = 0.10                    # one-sided, Holm-adjusted across the candidates compared for a task
COVERAGE_TOL = 8.0              # 80% range must really cover 72-88% of development outcomes
WIDTH_TOL = 1.10                # ...without being >10% wider than the incumbent's
MIN_FORWARD_BLOCKS = 30         # effective forward blocks (sessions / horizon) before a forward verdict is allowed
FORWARD_MIN_GAIN = 0.01         # forward MAE must beat the unchanged price by >= 1%
COOLDOWN_DAYS = 30
ROLLBACK_WORSE_PCT = 5.0        # auto-rollback if a promoted champion trails the unchanged price by >= 5% ...
ROLLBACK_MIN_BLOCKS = 20        # ...over at least this many forward blocks

PROMOTION_RULE = [
    "Only matured outcomes are ever used: a forecast becomes a training example only after its target session's official close exists.",
    "Every forecast is written to an append-only ledger (model version, feature schema, data cutoff, base price, range) before its outcome is known, and is never edited.",
    f"Gate 1 (development, walk-forward): a challenger must cut mean absolute error by at least {MIN_IMPROVEMENT:.0%} versus BOTH the unchanged price and the incumbent, in at least 2 of 3 chronological periods, with a one-sided block-bootstrap p-value below {ALPHA} after Holm correction for the number of challengers compared, and a range whose real coverage is within {COVERAGE_TOL:.0f} points of 80% and not more than 10% wider than the incumbent's.",
    f"Gate 2 (forward shadow): at least {MIN_FORWARD_BLOCKS} effective forward blocks (matured sessions divided by the horizon, because adjacent multi-session forecasts overlap), a forward MAE at least {FORWARD_MIN_GAIN:.0%} below the unchanged price and no worse than the incumbent, and a block-bootstrap 90% interval entirely below the unchanged price.",
    f"Promotion needs both gates and at most one promotion per task per {COOLDOWN_DAYS} days. Anything less retains the incumbent.",
    f"A promoted champion is rolled back automatically if, over at least {ROLLBACK_MIN_BLOCKS} forward blocks, it trails the unchanged price by {ROLLBACK_WORSE_PCT:.0f}% or more. Manual rollback is always available.",
    "Walk-forward numbers are development evidence, not an untouched test: they are re-examined every day, so only the forward record counts as out-of-sample proof.",
]


def make_intraday_model(name: str):
    if name == "ridge":
        return Pipeline([("s", StandardScaler()), ("r", Ridge(alpha=100.0))])
    if name == "hgb":
        return HistGradientBoostingRegressor(max_depth=3, learning_rate=0.04, max_iter=150, min_samples_leaf=40, l2_regularization=5.0, random_state=0)
    if name == "extra_trees":
        return ExtraTreesRegressor(n_estimators=150, max_depth=5, min_samples_leaf=40, max_features=0.6, random_state=0, n_jobs=-1)
    raise ValueError(name)


def cols_for(schema: str) -> list[str]:
    if schema == "gold_v1":
        return list(FEATURE_NAMES)
    if schema == "drivers_v1":
        return list(FEATURE_NAMES) + ["d_" + c for c in drivers.ALL_DRIVER_FEATURES]
    raise ValueError(schema)


TARGET_COVERAGE_PCT = 80.0
UNDER_CALIBRATED_MARGIN = 8.0        # "materially below target": more than 8 points under
LITTLE_CHANGE_PCT_PER_SQRT_SESSION = 0.10  # display rule only: |change| < 0.10% x sqrt(horizon in sessions) is shown as "little change"


def calibration_label(historical_pct: float | None, target: float = TARGET_COVERAGE_PCT) -> str | None:
    """'Under-calibrated' when the measured historical coverage is materially (> 8 points) below the claimed coverage."""
    if historical_pct is None:
        return None
    return "Under-calibrated" if historical_pct < target - UNDER_CALIBRATED_MARGIN else None


def little_change(change_pct: float, horizon_sessions: float = 1.0) -> tuple[bool, float]:
    """Display threshold for 'Little change predicted'. A presentation rule only: it is not a confidence level or an edge."""
    thr = LITTLE_CHANGE_PCT_PER_SQRT_SESSION * float(np.sqrt(max(horizon_sessions, 1.0)))
    return abs(change_pct) < thr, thr


def calibration_summary(task: str, ref_price: float | None = None) -> dict:
    """Range calibration for a task's champion, from chronological evidence only (walk-forward, then matured live outcomes)."""
    champ = registry.champion(task)["version"]
    dev = db.rows("SELECT metrics, data_through FROM dev_evals WHERE task=? AND version=? ORDER BY data_through DESC LIMIT 1", (task, champ))
    m = json.loads(dev[0]["metrics"]) if dev else {}
    fwd = ledger.stats(task, version=champ)
    hist = m.get("coverage_pct")
    out = {"target_pct": TARGET_COVERAGE_PCT, "historical_pct": hist, "historical_basis": "walk-forward: each range calibrated only on earlier data",
           "n_dates": m.get("n_origins"), "by_period_pct": m.get("by_period_coverage_pct"), "ci90_pct": m.get("coverage_ci90_pct"),
           "mean_width_pct": m.get("mean_width_pct"), "label": calibration_label(hist),
           "forward_pct": fwd.get("coverage_pct"), "forward_n": fwd.get("n_matured", 0), "data_through": dev[0]["data_through"] if dev else None}
    if ref_price and out["mean_width_pct"] is not None:
        out["mean_width_usd"] = float(ref_price * out["mean_width_pct"] / 100)
    return out


def _origin_epoch(d: pd.Timestamp) -> float:
    return (pd.Timestamp(d).tz_localize(NY) + pd.Timedelta(hours=13, minutes=30)).timestamp()


def _target_time(date_iso: str) -> str:
    return (pd.Timestamp(date_iso).tz_localize(NY) + pd.Timedelta(hours=13, minutes=30)).isoformat()


# --------------------------------------------------------------------------- #
# Issue forward forecasts (champion + shadows + baseline) for the latest completed session
# --------------------------------------------------------------------------- #
def fit_forecast(ds: dict, cols: list[str], algo: str, h: int) -> tuple[float, float, float]:
    """Log-return forecast and 80% range for the latest origin, using matured labels only.

    Range quantiles come from a model fitted on the first 80% and scored on the purged last 20%; the deployed point
    forecast is refitted on all matured labels."""
    X, y, pos = ds["X"][cols].to_numpy(), ds["y"], ds["pos"]
    vol = ds["vol60"] * np.sqrt(h)
    n = len(y)
    cut = int(n * (1 - rd.CALIB_FRAC))
    cal = np.arange(cut, n)
    cal = cal[pos[cal] > pos[cut - 1] + h]
    scale_now = float(ds["x_now"]["vol60"]) * np.sqrt(h)
    if algo == "unchanged":
        z = y[cal] / vol[cal]
        mu = 0.0
    else:
        z = (y[cal] - rd.ALGOS[algo]().fit(X[:cut], y[:cut]).predict(X[cal])) / vol[cal]
        mu = float(rd.ALGOS[algo]().fit(X, y).predict(ds["x_now"][cols].to_numpy(dtype=float).reshape(1, -1))[0])
    lo, hi = np.quantile(z, (1 - LEVEL) / 2), np.quantile(z, 1 - (1 - LEVEL) / 2)
    return mu, mu + float(lo) * scale_now, mu + float(hi) * scale_now


def issue_forward(close: pd.Series, drivers_df: pd.DataFrame | None, data_key: str, now: float | None = None) -> dict:
    now = now or time.time()
    base_date = close.index[-1]
    base_price = float(close.iloc[-1])
    out = {"issued": 0, "skipped": []}
    for h in (1, 5, 20):
        task = f"fwd_{h}"
        tdate = session_target_date(base_date, h)
        if pd.Timestamp(tdate) <= base_date:
            out["skipped"].append(f"{task}: target not in the future")
            continue
        try:
            ds = rd.build_dataset(close, h, drivers_df) if drivers_df is not None else None
        except Exception as exc:  # noqa: BLE001
            out["skipped"].append(f"{task}: dataset failed ({exc.__class__.__name__})")
            continue
        if ds is None or ds["x_now"] is None:
            out["skipped"].append(f"{task}: latest inputs incomplete")
            continue
        champ = registry.champion(task)["version"]
        for v in registry.versions(task):
            algo, schema = v["algorithm"], v["feature_schema"]
            try:
                mu, lo, hi = fit_forecast(ds, cols_for(schema) if algo != "unchanged" else [], algo, h)
            except Exception as exc:  # noqa: BLE001 - one failing candidate must not block the others
                out["skipped"].append(f"{v['version']}: {exc.__class__.__name__}")
                continue
            role = "champion" if v["version"] == champ else ("baseline" if algo == "unchanged" else "shadow")
            if ledger.issue(task=task, role=role, version=v["version"], algorithm=algo, feature_schema=schema, input_cutoff=_origin_epoch(base_date),
                            base_price=base_price, base_time=base_date.date().isoformat(), target_date=tdate, target_time=_target_time(tdate),
                            predicted=base_price * float(np.exp(mu)), low=base_price * float(np.exp(lo)), high=base_price * float(np.exp(hi)),
                            level=LEVEL, horizon=h, data_key=data_key, issued_at=now):
                out["issued"] += 1
            registry.mark_trained(v["version"], base_date.date().isoformat())
    return out


# --------------------------------------------------------------------------- #
# Development evaluation (walk-forward) and the promotion decision
# --------------------------------------------------------------------------- #
def _thirds(loss_m, loss_b):
    return [float(loss_m[t].mean() / loss_b[t].mean() - 1) * 100 for t in np.array_split(np.arange(len(loss_m)), 3)]


def dev_evaluate_forward(close: pd.Series, drivers_df: pd.DataFrame, data_through: str) -> dict[str, dict]:
    """Walk-forward development metrics for every forward candidate, on identical origins per horizon."""
    results: dict[str, dict] = {}
    for h in (1, 5, 20):
        task = f"fwd_{h}"
        ds = rd.build_dataset(close, h, drivers_df)
        runs = {}
        for v in registry.versions(task):
            if v["algorithm"] == "unchanged":
                continue
            runs[v["version"]] = rd.walk_forward(ds, cols_for(v["feature_schema"]), v["algorithm"], h)
        common = np.logical_and.reduce([r["ok"] for r in runs.values()])
        p0, ph, y = ds["p0"][common], ds["ph"][common], ds["y"][common]
        loss_b = np.abs(p0 - ph)
        for version, wf in runs.items():
            loss_m = np.abs(p0 * np.exp(wf["pred"][common]) - ph)
            lo, hi = wf["lo"][common], wf["hi"][common]
            hits = ((y >= lo) & (y <= hi)).astype(float)
            cov_lo, cov_hi = rd._block_bootstrap_ci(hits, block=max(h, 10), reps=1000)  # overlapping targets: resample blocks, not points
            results[version] = {
                "by_period_coverage_pct": [float(hits[t].mean() * 100) for t in np.array_split(np.arange(len(hits)), 3)],
                "coverage_ci90_pct": [float(cov_lo * 100), float(cov_hi * 100)], "horizon": h,
                "task": task, "n_origins": int(common.sum()), "mae": float(loss_m.mean()), "baseline_mae": float(loss_b.mean()),
                "mae_vs_baseline_pct": float((loss_m.mean() / loss_b.mean() - 1) * 100),
                "p_value_vs_baseline": rd.boot_p_value(loss_m - loss_b, max(h, 10)),
                "by_period_vs_baseline_pct": _thirds(loss_m, loss_b),
                "coverage_pct": float(np.mean((y >= lo) & (y <= hi)) * 100), "mean_width_pct": float(np.mean(hi - lo) * 100),
                "direction_pct": float(np.mean(np.sign(wf["pred"][common][y != 0]) == np.sign(y[y != 0])) * 100),
                "loss": loss_m.tolist(),  # kept in memory for incumbent comparison; stripped before storing
            }
    return results


def dev_evaluate_nowcast(daily: pd.Series, data_through: str) -> dict[str, dict]:
    rows = nowcast.training_rows(nowcast.build_frame(nowcast.fetch_hourly(), daily))
    sess = np.array(sorted(rows["session"].unique()))
    start = int(len(sess) * 0.5)
    X, y = rows[nowcast.FEATS].to_numpy(), rows["target"].to_numpy()
    p0, ph, s = rows["c"].to_numpy(), rows["session_close"].to_numpy(), rows["session"].to_numpy()
    oos = np.isin(s, sess[start:])
    out = {}
    for algo in registry.NOWCAST_ALGOS:
        pred = np.full(len(y), np.nan)
        for b in range(start, len(sess), 21):
            blk = sess[b:b + 21]
            tr, te = s < blk[0], np.isin(s, blk)
            if tr.sum() < 1000:
                continue
            pred[te] = make_intraday_model(algo).fit(X[tr], y[tr]).predict(X[te])
        ok = oos & ~np.isnan(pred)
        loss_m, loss_b = np.abs(p0[ok] * np.exp(pred[ok]) - ph[ok]), np.abs(p0[ok] - ph[ok])
        per = pd.DataFrame({"s": s[ok], "m": loss_m, "b": loss_b}).groupby("s").mean().sort_index()  # per-session: rows within a day are not independent
        out[registry.version_id("nowcast", algo, "intraday_v1")] = {
            "task": "nowcast", "n_origins": int(len(per)), "mae": float(per["m"].mean()), "baseline_mae": float(per["b"].mean()),
            "mae_vs_baseline_pct": float((per["m"].mean() / per["b"].mean() - 1) * 100),
            "p_value_vs_baseline": rd.boot_p_value((per["m"] - per["b"]).to_numpy(), 10),
            "by_period_vs_baseline_pct": _thirds(per["m"].to_numpy(), per["b"].to_numpy()),
            "coverage_pct": None, "mean_width_pct": None,
            "direction_pct": float(np.mean(np.sign(pred[ok][y[ok] != 0]) == np.sign(y[ok][y[ok] != 0])) * 100),
            "loss": per["m"].tolist()}
    return out


def holm_pass(pvals: dict[str, float], alpha: float = ALPHA) -> dict[str, bool]:
    """Holm-Bonferroni: which hypotheses survive correction for comparing len(pvals) candidates."""
    items = sorted(pvals.items(), key=lambda kv: kv[1])
    m, passed, still = len(items), {}, True
    for i, (k, p) in enumerate(items):
        still = still and p < alpha / (m - i)
        passed[k] = still
    return passed


def gate1(task: str, dev: dict[str, dict], champ_version: str) -> dict[str, dict]:
    cands = {v: m for v, m in dev.items() if m["task"] == task}
    survives = holm_pass({v: m["p_value_vs_baseline"] for v, m in cands.items()}) if cands else {}
    inc = cands.get(champ_version)
    verdicts = {}
    for v, m in cands.items():
        reasons = []
        if m["mae_vs_baseline_pct"] > -MIN_IMPROVEMENT * 100:
            reasons.append(f"MAE is {m['mae_vs_baseline_pct']:+.1f}% vs the unchanged price (needs <= -{MIN_IMPROVEMENT:.0%})")
        if inc is not None and v != champ_version and m["mae"] > (1 - MIN_IMPROVEMENT) * inc["mae"]:
            reasons.append(f"not at least {MIN_IMPROVEMENT:.0%} better than the incumbent ({m['mae']:.2f} vs {inc['mae']:.2f})")
        if sum(1 for x in m["by_period_vs_baseline_pct"] if x < 0) < 2:
            reasons.append("beats the unchanged price in fewer than 2 of 3 periods")
        if not survives.get(v, False):
            reasons.append(f"not statistically reliable after correcting for {len(cands)} candidates (p={m['p_value_vs_baseline']:.2f})")
        if m.get("coverage_pct") is not None:
            if abs(m["coverage_pct"] - 80) > COVERAGE_TOL:
                reasons.append(f"range covers {m['coverage_pct']:.0f}% instead of ~80%")
            if inc is not None and inc.get("mean_width_pct") and m["mean_width_pct"] > WIDTH_TOL * inc["mean_width_pct"]:
                reasons.append("range is much wider than the incumbent's")
        verdicts[v] = {"passes": not reasons, "reasons": reasons}
    return verdicts


def gate2(task: str, version: str, champ_version: str, h: int) -> dict:
    st = ledger.stats(task, version=version)
    blocks = ledger.effective_blocks(st.get("n_sessions", 0), h)
    base = {"blocks": round(blocks, 1), "needed": MIN_FORWARD_BLOCKS, "n_matured": st.get("n_matured", 0), "stats": st}
    if blocks < MIN_FORWARD_BLOCKS:
        return {**base, "passes": False, "reason": f"only {blocks:.1f} of {MIN_FORWARD_BLOCKS} effective forward blocks have matured"}
    inc = ledger.stats(task, version=champ_version) if version != champ_version else st
    reasons = []
    if st["mae_vs_baseline_pct"] > -FORWARD_MIN_GAIN * 100:
        reasons.append(f"forward MAE {st['mae_vs_baseline_pct']:+.1f}% vs unchanged price")
    if inc.get("mae") and st["mae"] > inc["mae"]:
        reasons.append("forward MAE worse than the incumbent")
    ci = st.get("mae_diff_ci90_pct")
    if not ci or ci[1] >= 0:
        reasons.append("forward 90% interval is not entirely below the unchanged price")
    return {**base, "passes": not reasons, "reason": "; ".join(reasons) or "forward evidence supports promotion"}


def decide(task: str, dev: dict[str, dict]) -> dict:
    """Apply the documented rule for one task. Returns the decision record (also written to the decision log)."""
    h = {"nowcast": 1, "fwd_1": 1, "fwd_5": 5, "fwd_20": 20}[task]
    champ = registry.champion(task)
    # Auto-rollback of a promoted champion that is failing forward.
    if champ["algorithm"] != "unchanged" and champ["notes"] != "seeded: the model already in production":
        st = ledger.stats(task, version=champ["version"], since_issued=champ["status_changed_at"])
        if ledger.effective_blocks(st.get("n_sessions", 0), h) >= ROLLBACK_MIN_BLOCKS and (st.get("mae_vs_baseline_pct") or 0) >= ROLLBACK_WORSE_PCT:
            to = registry.rollback(task, reason=f"automatic: forward MAE {st['mae_vs_baseline_pct']:+.1f}% vs the unchanged price over {st['n_sessions']} sessions")
            return {"task": task, "decision": "rollback", "champion": to}
    g1 = gate1(task, dev, champ["version"])
    last_promo = db.rows("SELECT MAX(at) AS at FROM decisions WHERE task=? AND decision='promote'", (task,))[0]["at"]
    cooling = bool(last_promo and time.time() - last_promo < COOLDOWN_DAYS * 86400)
    best, evidence = None, {}
    for v, verdict in g1.items():
        if v == champ["version"]:
            continue
        forward = gate2(task, v, champ["version"], h)
        evidence[v] = {"development": {"passes": verdict["passes"], "reasons": verdict["reasons"],
                                       "mae_vs_baseline_pct": round(dev[v]["mae_vs_baseline_pct"], 2), "p": round(dev[v]["p_value_vs_baseline"], 3)},
                       "forward": {k: forward[k] for k in ("passes", "reason", "blocks", "needed", "n_matured")}}
        if verdict["passes"] and forward["passes"] and not cooling and (best is None or dev[v]["mae"] < dev[best]["mae"]):
            best = v
    if best:
        registry.promote(task, best, "Passed development gate and forward shadow gate.", evidence[best])
        return {"task": task, "decision": "promote", "champion": best, "evidence": evidence}
    n_dev = sum(1 for e in evidence.values() if e["development"]["passes"])
    fwd_blocks = max([e["forward"]["blocks"] for e in evidence.values()] or [0])
    reason = (f"Retained {champ['version']}. {n_dev} of {len(evidence)} challengers passed the development gate; "
              f"the most forward evidence on any challenger is {fwd_blocks} of {MIN_FORWARD_BLOCKS} effective blocks."
              + (" Promotion is on cooldown." if cooling else ""))
    registry.log_decision(task, "evaluation", "retain", reason, champ["version"], champ["version"], evidence)
    return {"task": task, "decision": "retain", "champion": champ["version"], "reason": reason}


def _store_dev(data_through: str, dev: dict[str, dict]) -> None:
    now = time.time()
    with db.tx() as c:
        for v, m in dev.items():
            slim = {k: x for k, x in m.items() if k != "loss"}
            c.execute("INSERT OR REPLACE INTO dev_evals VALUES (?,?,?,?,?)", (data_through, m["task"], v, now, __import__("json").dumps(slim)))


def run_learning(close: pd.Series, drivers_df: pd.DataFrame | None, data_key: str, force: bool = False) -> dict:
    """One full learning pass for fresh completed-session data. Failures leave the champion untouched."""
    registry.seed()
    data_through = close.index[-1].date().isoformat()
    summary: dict = {"data_through": data_through, "matured": ledger.mature(close), "errors": {}}
    summary["forward_issue"] = issue_forward(close, drivers_df, data_key)
    if force:
        db.connect().execute("DELETE FROM dev_evals WHERE data_through=?", (data_through,))  # dev_evals is a cache, not the ledger
    done = db.rows("SELECT 1 FROM dev_evals WHERE data_through=? LIMIT 1", (data_through,))
    if done:
        summary["development"] = "already evaluated for this data"
        return summary
    dev: dict[str, dict] = {}
    for name, fn in (("forward", lambda: dev_evaluate_forward(close, drivers_df, data_through) if drivers_df is not None else {}),
                     ("nowcast", lambda: dev_evaluate_nowcast(close, data_through))):
        try:
            dev.update(fn())
        except Exception as exc:  # noqa: BLE001 - a failed evaluation must never disturb the champion
            summary["errors"][name] = f"{exc.__class__.__name__}: {exc}"
    if dev:
        _store_dev(data_through, dev)
        summary["decisions"] = [decide(t, dev) for t in registry.TASKS if any(m["task"] == t for m in dev.values())]
    return summary


# --------------------------------------------------------------------------- #
# Read side: what the "Model details" drawer shows
# --------------------------------------------------------------------------- #
def status_payload() -> dict:
    registry.seed()
    tasks = {}
    for task in registry.TASKS:
        h = {"nowcast": 1, "fwd_1": 1, "fwd_5": 5, "fwd_20": 20}[task]
        champ = registry.champion(task)
        dev = db.rows("SELECT metrics, data_through FROM dev_evals WHERE task=? AND version=? ORDER BY data_through DESC LIMIT 1", (task, champ["version"]))
        base_ver = registry.baseline_version(task)
        fwd = ledger.stats(task, version=champ["version"])
        fwd_base = ledger.stats(task, role="baseline") if task != "nowcast" else None
        last = db.rows("SELECT * FROM decisions WHERE task=? ORDER BY id DESC LIMIT 1", (task,))
        n_all = db.rows("SELECT COUNT(*) AS n FROM forecasts WHERE task=?", (task,))[0]["n"]
        tasks[task] = {
            "champion": {k: champ[k] for k in ("version", "algorithm", "feature_schema", "status_changed_at", "last_trained_at", "trained_through")},
            "baseline_version": base_ver, "forecasts_issued": n_all,
            "forward": {**fwd, "effective_blocks": round(ledger.effective_blocks(fwd.get("n_sessions", 0), h), 1), "needed_for_verdict": MIN_FORWARD_BLOCKS},
            "development": (lambda r: {**__import__("json").loads(r[0]["metrics"]), "data_through": r[0]["data_through"]} if r else None)(dev),
            "calibration": calibration_summary(task),
            "last_decision": ({k: last[0][k] for k in ("at", "decision", "reason", "champion_after")} if last else None),
            "challengers": [{"version": v["version"], "status": v["status"], "last_trained_at": v["last_trained_at"],
                             "forward": ledger.stats(task, version=v["version"])} for v in registry.versions(task) if v["status"] != "champion" and v["algorithm"] != "unchanged"],
        }
    return {"tasks": tasks, "rule": PROMOTION_RULE, "history": registry.decisions(30),
            "matured_total": db.rows("SELECT COUNT(*) AS n FROM outcomes")[0]["n"], "issued_total": db.rows("SELECT COUNT(*) AS n FROM forecasts")[0]["n"]}
