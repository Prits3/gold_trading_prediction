import type { CalibrationInfo, ForecastResult, ForwardPayload, FrozenForecast, Horizon, TodayPayload } from "../types";
import { arrow, dirClass, fmtEt, fmtIsoEt, num, pct, signed } from "../format";
import { Info } from "./Common";

const usd = (v: number) => `$${num(v)}`;
const targetLong = (iso: string) => `${fmtIsoEt(iso, { weekday: "short", day: "numeric", month: "short", year: "numeric" })} · ${fmtIsoEt(iso, { hour: "2-digit", minute: "2-digit", hour12: false })} ET`;
const issuedLong = (epoch: number) => `${fmtEt(epoch, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })} ET`;

function Calibration({ c, f }: { c: CalibrationInfo; f: FrozenForecast }) {
  const hist = c.historical_pct;
  const width = c.mean_width_usd ?? (f.high - f.low);
  const detail = [
    c.historical_basis ? `Basis: ${c.historical_basis}.` : "",
    c.n_dates ? `${c.n_dates} chronological dates.` : "",
    c.ci90_pct ? `90% interval for the coverage: ${num(c.ci90_pct[0], 0)}–${num(c.ci90_pct[1], 0)}%.` : "",
    c.by_period_pct ? `By period (oldest → newest): ${c.by_period_pct.map((x) => `${num(x, 0)}%`).join(" · ")}.` : "",
    c.forward_n ? `Live matured outcomes: ${c.forward_n}${c.forward_pct != null ? `, ${num(c.forward_pct, 0)}% inside the range` : ""}.` : "No live outcomes have matured yet.",
    "Ranges are calibrated only on information available at the time; nothing was tuned on the reported period.",
  ].filter(Boolean).join(" ");
  return (
    <p className="gx-cal" data-testid="calibration">
      Target coverage: {num(c.target_pct, 0)}%. Historical coverage: {hist != null ? `${num(hist, 0)}%` : "not yet measured"}.
      {c.label && <span className="gx-warn" data-testid="calibration-label"> {c.label}</span>}
      <span className="gx-muted"> · Range width ≈ ${num(width, 0)}{c.mean_width_pct != null ? ` (${num(c.mean_width_pct, 1)}% of price)` : ""}.</span>
      <Info label="Calibration" text={detail} />
    </p>
  );
}

function Body({ f, cal, referenceLabel, result, completed, tail, isNext }: {
  f: FrozenForecast; cal?: CalibrationInfo; referenceLabel: string; result?: ForecastResult | null; completed: boolean; tail?: React.ReactNode; isNext?: boolean;
}) {
  const isBase = f.source.kind === "baseline";
  const tgt = targetLong(f.target_time);
  const dir = dirClass(f.change);
  const sentence = isBase
    ? `No model is in control for this target. The unchanged-price baseline ${completed ? "held" : "holds"} gold futures at ${usd(f.predicted)} by ${tgt}, the price when this forecast was issued.`
    : `The model ${completed ? "predicted" : "predicts"} gold futures at ${usd(f.predicted)} by ${tgt}, compared with ${usd(f.reference_price)} when this forecast was issued.`;
  return (
    <>
      <div className="gx-pricerow">
        <div className="gx-big mono" data-testid={isNext ? "today-pred" : "fwd-pred"}>{usd(f.predicted)}</div>
        <span className={`gx-chip ${isBase ? "base" : ""}`} data-testid="source-chip">{f.source.label}</span>
        <Info label="Where this number comes from" text={`${isBase ? "This is the unchanged-price baseline, not a learned prediction: it equals the futures price at the moment of issue. " : ""}Version ${f.source.version} (${f.source.role}). Target: ${f.source.target_def}. Reference price ${usd(f.reference_price)}. Inputs cut off at ${issuedLong(f.input_cutoff)}; issued ${issuedLong(f.issued_at)}.`} />
      </div>
      <div className={`gx-sub mono ${f.little_change ? "flat" : dir}`} data-testid={isNext ? "today-vs" : "fwd-change"}>
        {f.little_change
          ? <>Little change predicted <span className="gx-muted">({signed(f.change)} / {pct(f.change_pct)})</span><Info label="Little change" text={`Shown when the predicted change is smaller than ${num(f.little_change_threshold_pct, 2)}% (0.10% × √sessions). A display rule only — not a confidence level and not an edge.`} /></>
          : <><span aria-hidden="true">{arrow(f.change)}</span> {signed(f.change)} / {pct(f.change_pct)}</>}
      </div>
      <p className="gx-sentence" data-testid={isNext ? "today-sentence" : "fwd-sentence"}>{sentence}</p>
      <dl className="gx-facts">
        <div><dt>Target</dt><dd>{tgt}</dd></div>
        <div><dt>Change from reference</dt><dd className="mono">{signed(f.change)} / {pct(f.change_pct)} <span className="gx-muted">· reference {usd(f.reference_price)}, {referenceLabel}</span></dd></div>
        <div><dt>{Math.round(f.level * 100)}% range</dt><dd className="mono">{usd(f.low)}–{usd(f.high)}</dd></div>
        <div><dt>Issued</dt><dd className="mono">{issuedLong(f.issued_at)}</dd></div>
      </dl>
      {cal && <Calibration c={cal} f={f} />}
      {completed && (
        <div className="gx-completed" data-testid="completed-banner">
          <b>Completed</b> — the target time has passed.{" "}
          {result?.matured ? <>Actual <span className="mono">{usd(result.actual!)}</span>, off by <span className="mono">${num(result.abs_error!)}</span>{result.in_range != null ? (result.in_range ? ", inside the range" : ", outside the range") : ""}.</> : "The official figure is not available yet."}
        </div>
      )}
      {tail}
    </>
  );
}

export function NextSettlementCard({ d, err }: { d: TodayPayload | null; err: string | null }) {
  if (!d) return <section className="gx-card" data-testid="today-card"><h2>NEXT SETTLEMENT</h2><p className="gx-muted">{err ?? "Loading forecast…"}</p></section>;
  const f = d.forecast;
  const completed = d.status === "completed";
  return (
    <section className="gx-card" aria-label="Next settlement forecast" data-testid="today-card" data-status={d.status}>
      <div className="gx-card-head"><h2>NEXT SETTLEMENT</h2><span className="gx-chip">Futures · GC=F</span></div>
      {!f ? <p className="gx-muted">{d.message}</p> : (
        <Body f={f} cal={d.calibration} isNext completed={completed} result={d.result}
          referenceLabel={`the latest futures price when issued (${fmtEt(f.input_cutoff, { hour: "2-digit", minute: "2-digit", hour12: false })} ET)`}
          tail={<>
            {d.live && !completed && (
              <p className="gx-live" data-testid="live-compare">
                <b>Latest futures quote</b> (separate from the forecast): <span className="mono">{usd(d.live.price)}</span>{d.live.delay_seconds > 120 ? ` · ~${Math.round(d.live.delay_seconds / 60)} min delayed` : ""} ·{" "}
                <span className={`mono ${dirClass(d.live.vs_forecast)}`}>{signed(d.live.vs_forecast)} vs this forecast</span>
              </p>
            )}
            <p className="gx-micro">{completed ? d.message : d.next_update_epoch ? `Next forecast ${fmtEt(d.next_update_epoch, { hour: "2-digit", minute: "2-digit", hour12: false })} ET (hourly while the market is open).` : "Market closed: no new forecast until it reopens."}</p>
            {d.last_result && d.last_result.status === "awaiting_official_figure" && <p className="gx-micro">Previous settlement ({d.last_result.target_date}): predicted {usd(d.last_result.predicted)}; official figure not posted yet.</p>}
          </>} />
      )}
    </section>
  );
}

export function ForwardCard({ d, err, horizon, onHorizon }: { d: ForwardPayload | null; err: string | null; horizon: Horizon; onHorizon: (h: Horizon) => void }) {
  const f = d?.forecast;
  const completed = d?.status === "completed";
  return (
    <section className="gx-card" aria-label="Forward forecast" data-testid="forward-card" data-status={d?.status ?? "loading"}>
      <div className="gx-card-head">
        <h2>FORWARD FORECAST</h2><span className="gx-chip">Futures · GC=F</span>
        <div className="gx-seg sm" role="tablist" aria-label="Horizon" style={{ marginLeft: "auto" }}>
          {([1, 5, 20] as const).map((h) => (
            <button key={h} role="tab" aria-selected={horizon === h} className={horizon === h ? "on" : ""} onClick={() => onHorizon(h)} data-testid={`h-${h}`}>{h}{h === 1 ? " session" : " sessions"}</button>
          ))}
        </div>
      </div>
      {!d ? <p className="gx-muted">{err ?? "Loading forecast…"}</p> : !f ? (
        <p className="gx-muted gx-explain" data-testid="fwd-none">{d.message ?? err}</p>
      ) : (
        <Body f={f} cal={d.calibration} completed={completed} result={d.result}
          referenceLabel={`official settlement of ${d.base_date}`}
          tail={<>
            {d.evaluation?.forward && <p className="gx-micro" data-testid="fwd-perf">Live record: {d.evaluation.forward.n_matured ? `${d.evaluation.forward.n_matured} scored, error ${signed(d.evaluation.forward.mae_vs_baseline_pct ?? 0, 1)}% vs assuming no change` : "none scored yet"}.
              {d.evaluation.development ? ` Historical walk-forward: error ${signed(d.evaluation.development.mae_vs_baseline_pct, 1)}% vs no change, direction right ${num(d.evaluation.development.direction_pct, 0)}%.` : ""}
              {d.evaluation.development && d.evaluation.development.mae_vs_baseline_pct > -2 ? " No demonstrated advantage over assuming the price stays put." : ""}</p>}
            {d.next_forecast && <p className="gx-micro gx-explain" data-testid="next-forecast">{d.next_forecast.message}</p>}
          </>} />
      )}
    </section>
  );
}
