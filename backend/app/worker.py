"""Background worker: collection, forecasting, scoring and learning. Independent of the web UI and the browser.

    python -m app.worker run        long-running daemon (what launchd keeps alive)
    python -m app.worker once       one full cycle now (collect -> score -> issue -> learn), then exit
    python -m app.worker status     what ran, when, and what is in charge
    python -m app.worker rollback <task> [version]

Guarantees:
  * One daemon at a time (file lock). A second ``run`` exits immediately; the web app only starts an in-process worker when
    no other one holds the lock.
  * Each job has its own lock, so retraining can never overlap itself.
  * A failing job is logged and skipped; the last valid data, forecasts and champion stay in place.
  * A sleeping or powered-off Mac records nothing. On wake the daemon catches up by re-downloading history (futures OHLC,
    daily closes, drivers) and issuing any overdue cycle. Spot ticks and hourly intraday forecasts missed while asleep
    cannot be reconstructed, so those periods stay as visible gaps.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

import pandas as pd

from . import alerts, config, db, drivers, ledger, learning, n8n_link, news_store, nowcast, quote, registry, threshold_research
from .data import DataStore, DataUnavailable

log = logging.getLogger("gold.worker")
SPOT_EVERY = 10
CYCLE_UTC = (23, 30)           # daily full cycle (after the 17:00 ET close and the daily bar completes)
ALERT_EVERY = 120             # forecast + quote checks, hand-off and delivery
SCORE_EVERY = 30 * 60          # look for newly matured outcomes this often
LEARN_CHECK_EVERY = 5 * 60     # check whether a newly completed session needs forecasts (cheap; the data is cached)
OVERDUE_AFTER = 26 * 3600


def _lock_dir():
    d = config.DATA_DIR / "locks"
    d.mkdir(parents=True, exist_ok=True)
    return d


@contextmanager
def file_lock(name: str, blocking: bool = False):
    """Exclusive advisory lock. Yields True if acquired, False if another process holds it."""
    fd = os.open(_lock_dir() / f"{name}.lock", os.O_CREAT | os.O_RDWR)
    got = False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            got = True
        except OSError:
            got = False
        yield got
    finally:
        if got:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def run_job(name: str, fn, *args, lock: bool = True):
    """Run ``fn`` under a per-job lock and record the outcome. Never raises."""
    conn = db.connect()
    with file_lock(name) as got:
        if lock and not got:
            conn.execute("INSERT INTO job_runs (job,started_at,finished_at,status,detail) VALUES (?,?,?,?,?)",
                         (name, time.time(), time.time(), "skipped", "another instance of this job is already running"))
            return None
        cur = conn.execute("INSERT INTO job_runs (job,started_at,status) VALUES (?,?,?)", (name, time.time(), "running"))
        rid = cur.lastrowid
        try:
            out = fn(*args)
            conn.execute("UPDATE job_runs SET finished_at=?, status='ok', detail=? WHERE id=?", (time.time(), json.dumps(out, default=str)[:1500] if out is not None else None, rid))
            return out
        except Exception as exc:  # noqa: BLE001 - a failing job keeps the previous valid state
            log.warning("job %s failed: %s", name, exc)
            conn.execute("UPDATE job_runs SET finished_at=?, status='error', detail=? WHERE id=?", (time.time(), f"{exc.__class__.__name__}: {exc}"[:1500], rid))
            return None


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #
_store = DataStore()


def job_spot() -> dict:
    raw = quote.poll_spot()
    return {"price": raw["price"], "tick_epoch": raw["tick_epoch"]}


def job_collect() -> dict:
    """Download fresh completed-session data and driver inputs. Existing valid data survives any failure."""
    out: dict = {}
    ds = _store.get(force_refresh=True)
    out["data_through"] = ds.series.index[-1].date().isoformat()
    out["provider_error"] = ds.meta.get("provider_error")
    for name, fn in (("drivers", lambda: drivers.load(force=True)), ("news", news_store.collect)):
        try:
            r = fn()
            out[name] = "ok" if name == "drivers" else r
        except Exception as exc:  # noqa: BLE001
            out[name] = f"failed: {exc.__class__.__name__}"
    return out


def job_score() -> dict:
    ds = _store.get()
    return {"matured": ledger.mature(ds.series), "data_through": ds.series.index[-1].date().isoformat()}


def issue_nowcast(daily: pd.Series) -> dict:
    """Write this hour's today's-close forecasts (champion, shadows, baseline). Idempotent within the hour."""
    p = nowcast.get(daily)
    if not p["market_open"] or p["hours_left"] <= 0:
        return {"issued": 0, "why": "market closed or target passed"}
    registry.seed()
    champ = registry.champion("nowcast")["version"]
    hour = pd.Timestamp(p["anchor_time_epoch"], unit="s", tz="UTC").floor("h").isoformat()
    n = 0
    packs = [("unchanged", "price_now_v1", p["baseline_forecast"])] + [(c["algorithm"], "intraday_v1", c) for c in p["candidates"]]
    for algo, schema, pk in packs:
        v = registry.version_id("nowcast", algo, schema)
        role = "champion" if v == champ else ("baseline" if algo == "unchanged" else "shadow")
        registry.mark_trained(v, p["target_date"])  # these models are refit on every intraday state rebuild
        if ledger.issue(task="nowcast", role=role, version=v, algorithm=algo, feature_schema=schema, input_cutoff=p["anchor_time_epoch"],
                        base_price=p["anchor_price"], base_time=hour, target_date=p["target_date"], target_time=p["target_time"],
                        predicted=pk["predicted_close"], low=pk["low"], high=pk["high"], level=p["level"], horizon=None,
                        hours_left=p["hours_left"], data_key=f"{daily.index[-1].date()}|{len(daily)}"):
            n += 1
    return {"issued": n, "target_date": p["target_date"], "hours_left": p["hours_left"]}


def job_nowcast() -> dict:
    return issue_nowcast(_store.get().series)


def job_learn(force: bool = False) -> dict:
    ds = _store.get()
    try:
        d = drivers.load()
    except drivers.DriversUnavailable:
        d = None
    return learning.run_learning(ds.series, d, ds.key, force=force)


def job_threshold(force: bool = False) -> dict:
    """Touch/endpoint threshold research (chronological, once per data version) and the forward touch record. Never touches the models."""
    ds = _store.get()
    try:
        d = drivers.load()
    except drivers.DriversUnavailable:
        d = None
    levels = alerts.get_settings()["levels"]
    ohlc = threshold_research.get_ohlc()
    prev = threshold_research.latest()
    through = ds.series.index[-1].date().isoformat()
    if force or prev is None or prev.get("data_through") != through or prev.get("levels") != levels:
        prev = threshold_research.run(ds.series, ohlc, d, levels, through)
    rec = threshold_research.record_forward(ds.series, ohlc, d, levels, prev)
    return {"status": prev["status"], "variant": prev["selected_variant"], "forward": rec, "matured": threshold_research.mature_forward(ohlc)}


def job_alerts() -> dict:
    """Evaluate review levels (forecast heads-up and observed-price crossing are independent), then hand off to n8n. Read-only on forecasts."""
    out = {"forecast": alerts.check_forecasts()["new_events"], "price": alerts.check_price()["new_events"]}
    out["delivery"] = n8n_link.deliver_pending()
    out["handoff"] = n8n_link.push_snapshot()["state"]
    out["sync"] = n8n_link.sync_status().get("state")
    return out


def full_cycle() -> dict:
    """collect -> score -> issue forward forecasts -> develop/evaluate challengers -> decide."""
    out = {"collect": run_job("collect", job_collect)}
    out["score"] = run_job("score", job_score)
    out["learn"] = run_job("learn", job_learn)  # holds the 'learn' lock: retraining cannot overlap itself
    out["nowcast"] = run_job("nowcast", job_nowcast)
    out["threshold"] = run_job("threshold", job_threshold)
    out["alerts"] = run_job("alerts", job_alerts)
    return out


def needs_learning(daily: pd.Series) -> bool:
    """True when a completed session exists for which no forward forecast has been issued yet (fresh data arrived)."""
    r = db.rows("SELECT MAX(base_time) AS m FROM forecasts WHERE task LIKE 'fwd_%'")[0]["m"]
    return r != daily.index[-1].date().isoformat()


def last_ok(job: str) -> float | None:
    r = db.rows("SELECT MAX(finished_at) AS t FROM job_runs WHERE job=? AND status='ok'", (job,))
    return r[0]["t"] if r else None


def cycle_overdue(now: float | None = None) -> bool:
    t = last_ok("learn")
    return t is None or (now or time.time()) - t > OVERDUE_AFTER


# --------------------------------------------------------------------------- #
# Daemon
# --------------------------------------------------------------------------- #
def _heartbeat(state: dict) -> None:
    p = config.DATA_DIR / "worker_heartbeat.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps({**state, "pid": os.getpid(), "at": time.time()}))
    tmp.replace(p)


def run_loop(stop: threading.Event | None = None, once_overdue: bool = True) -> bool:
    """Run until ``stop`` is set. Returns False immediately if another worker already holds the daemon lock."""
    stop = stop or threading.Event()
    registry.seed()
    with file_lock("daemon") as got:
        if not got:
            return False
        log.info("worker started (pid %s)", os.getpid())
        last_spot = last_score = last_hb = last_learn = last_alerts = 0.0
        last_hour = -1
        last_cycle_day = None
        if once_overdue and cycle_overdue():
            log.info("catch-up: the last full cycle is overdue; running it now (also re-downloads history after any sleep)")
            full_cycle()
            last_cycle_day = datetime.now(timezone.utc).date()
        while not stop.is_set():
            now = time.time()
            if now - last_spot >= SPOT_EVERY:
                run_job("spot", job_spot, lock=False)
                last_spot = now
            hour = int(now // 3600)
            if hour != last_hour:
                run_job("nowcast", job_nowcast)
                last_hour = hour
            if now - last_score >= SCORE_EVERY:
                run_job("score", job_score)
                last_score = now
            if now - last_learn >= LEARN_CHECK_EVERY:
                last_learn = now
                try:  # fresh completed-session data -> issue the new forecasts promptly (the heavy evaluation runs once per data version)
                    if needs_learning(_store.get().series):
                        run_job("learn", job_learn)
                        run_job("threshold", job_threshold)
                        last_alerts = 0.0   # a newly issued forecast is evaluated against the review levels now, not in two minutes
                except Exception as exc:  # noqa: BLE001
                    log.warning("learn trigger failed: %s", exc)
            if now - last_alerts >= ALERT_EVERY:
                last_alerts = now
                run_job("alerts", job_alerts)
            utc = datetime.now(timezone.utc)
            if (utc.hour, utc.minute) >= CYCLE_UTC and last_cycle_day != utc.date():
                full_cycle()
                last_cycle_day = utc.date()
            if now - last_hb >= 20:
                _heartbeat({"state": "running"})
                last_hb = now
            stop.wait(2.0)
        return True


def heartbeat_age() -> float | None:
    try:
        return time.time() - json.loads((config.DATA_DIR / "worker_heartbeat.json").read_text())["at"]
    except Exception:  # noqa: BLE001
        return None


def status() -> dict:
    registry.seed()
    hb = heartbeat_age()
    jobs = {}
    for j in ("spot", "collect", "score", "learn", "nowcast", "threshold", "alerts"):
        r = db.rows("SELECT status, started_at, finished_at, detail FROM job_runs WHERE job=? ORDER BY id DESC LIMIT 1", (j,))
        ok = last_ok(j)
        jobs[j] = {"last": r[0] if r else None, "last_ok": ok, "age_s": None if ok is None else round(time.time() - ok)}
    return {"daemon_running": hb is not None and hb < 90, "heartbeat_age_s": None if hb is None else round(hb),
            "jobs": jobs, "champions": {t: registry.champion(t)["version"] for t in registry.TASKS},
            "forecasts": db.rows("SELECT COUNT(*) AS n FROM forecasts")[0]["n"], "matured": db.rows("SELECT COUNT(*) AS n FROM outcomes")[0]["n"],
            "spot_ticks": db.rows("SELECT COUNT(*) AS n FROM spot_ticks")[0]["n"], "cycle_overdue": cycle_overdue()}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="app.worker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    sub.add_parser("once")
    sub.add_parser("learn").add_argument("--force", action="store_true", help="re-run the development evaluation for the current data")
    sub.add_parser("status").add_argument("--json", action="store_true")
    al = sub.add_parser("alerts", help="evaluate review levels now, or simulate prices/forecasts safely")
    al.add_argument("--simulate", action="store_true", help="use a throwaway database; never contacts n8n or sends an SMS")
    al.add_argument("--price", type=float, help="simulated observed quote (USD/oz)")
    al.add_argument("--forecast", type=float, help="simulated next-session forecast (USD/oz)")
    sub.add_parser("threshold").add_argument("--force", action="store_true")
    rb = sub.add_parser("rollback")
    rb.add_argument("task", choices=registry.TASKS)
    rb.add_argument("version", nargs="?")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if a.cmd == "run":
        return 0 if run_loop() else (print("another worker already holds the lock; exiting") or 0)
    if a.cmd == "learn":
        print(json.dumps(run_job("learn", job_learn, a.force), indent=1, default=str))
        return 0
    if a.cmd == "threshold":
        print(json.dumps(run_job("threshold", job_threshold, a.force), indent=1, default=str))
        return 0
    if a.cmd == "alerts":
        if a.simulate:
            from . import alerts_sim
            print(json.dumps(alerts_sim.simulate(price=a.price, forecast=a.forecast), indent=1, default=str))
        else:
            print(json.dumps(run_job("alerts", job_alerts), indent=1, default=str))
        return 0
    if a.cmd == "once":
        print(json.dumps(full_cycle(), indent=1, default=str))
        return 0
    if a.cmd == "rollback":
        print("champion is now", registry.rollback(a.task, a.version))
        return 0
    s = status()
    if a.json:
        print(json.dumps(s, indent=1, default=str))
        return 0
    now = time.time()
    fmt = lambda t: "never" if t is None else f"{int((now - t) // 60)} min ago"  # noqa: E731
    print(f"daemon: {'RUNNING' if s['daemon_running'] else 'not running'}"
          + (f" (heartbeat {s['heartbeat_age_s']}s ago)" if s["heartbeat_age_s"] is not None else ""))
    for j, v in s["jobs"].items():
        last = v["last"]
        print(f"  {j:8s} last ok: {fmt(v['last_ok']):>12s}   last run: {last['status'] if last else '-'}")
    print(f"forecasts logged: {s['forecasts']}  matured: {s['matured']}  spot ticks: {s['spot_ticks']}  full cycle overdue: {s['cycle_overdue']}")
    for t, v in s["champions"].items():
        print(f"  champion {t:8s} {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
