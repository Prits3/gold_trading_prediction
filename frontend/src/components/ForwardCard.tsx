import type { ForwardForecast, ForwardPending, Horizon, InstrumentKey } from "../types";
import { dirClass, fmtIsoEt, num, pct, signed, fmtEtShort } from "../format";
import { Info } from "./Common";

export function ForwardCard({ d, err, horizon, onHorizon, instrument }: {
  d: ForwardForecast | ForwardPending | null; err: string | null; horizon: Horizon; onHorizon: (h: Horizon) => void; instrument: InstrumentKey;
}) {
  const pending = d && "status" in d ? d : null;
  const fc = d && !("status" in d) ? d : null;
  const dev = fc?.evaluation.development, fw = fc?.evaluation.forward;
  return (
    <section className="gx-card" aria-label="Forward forecast" data-testid="forward-card">
      <div className="gx-card-head">
        <h2>Forward forecast</h2>
        <span className="gx-chip">Futures · GC=F</span>
        <Info label="Forward forecast" text="Forecast of the official futures settlement N sessions after the latest completed session. Chosen from a small set of models by a documented, evidence-based rule; most days the incumbent is retained. The comparison line shows how it has done against simply assuming the price will not change." />
        <div className="gx-seg sm" role="tablist" aria-label="Horizon" style={{ marginLeft: "auto" }}>
          {([1, 5, 20] as const).map((h) => (
            <button key={h} role="tab" aria-selected={horizon === h} className={horizon === h ? "on" : ""} onClick={() => onHorizon(h)} data-testid={`h-${h}`}>{h}{h === 1 ? " session" : " sessions"}</button>
          ))}
        </div>
      </div>
      {pending ? <p className="gx-muted" data-testid="fwd-pending">{pending.message}</p> : !fc ? <p className="gx-muted">{err ?? "Loading forecast…"}</p> : (
        <>
          <div className="gx-big mono" data-testid="fwd-pred">{num(fc.predicted)}</div>
          <div className={`gx-sub mono ${dirClass(fc.change_pct)}`} data-testid="fwd-change">
            {pct(fc.change_pct)} <span className="gx-muted">from base {num(fc.base_price)} (settlement {fmtIsoEt(fc.base_date + "T12:00:00Z", { day: "numeric", month: "short" })})</span>
          </div>
          <dl className="gx-facts">
            <div><dt>Target</dt><dd>Settlement · {fmtIsoEt(fc.target_time, { weekday: "short", day: "numeric", month: "short", year: "numeric" })} · 13:30 ET</dd></div>
            <div><dt>{Math.round(fc.level * 100)}% range</dt><dd className="mono">{num(fc.low)} – {num(fc.high)}</dd></div>
            <div><dt>Issued</dt><dd className="mono">{fmtEtShort(fc.issued_at)} ET · {fc.algorithm.replace("_", " ")} · {fc.feature_schema}</dd></div>
          </dl>
          <p className="gx-perf" data-testid="fwd-perf">
            {fw && fw.n_matured > 0
              ? `Live record: ${fw.n_matured} scored, error ${signed(fw.mae_vs_baseline_pct ?? 0, 1)}% vs assuming no change.`
              : "Live record: none scored yet."}
            {dev ? ` Historical walk-forward: error ${signed(dev.mae_vs_baseline_pct, 1)}% vs no change, direction right ${num(dev.direction_pct, 0)}%, range held ${dev.coverage_pct != null ? num(dev.coverage_pct, 0) : "—"}%.` : ""}
            {dev && dev.mae_vs_baseline_pct > -2 ? " No demonstrated advantage over assuming the price stays put." : ""}
          </p>
          {instrument === "spot" && <p className="gx-note">Shown for gold futures. Spot has no separately evaluated model, so these numbers are not claimed for spot.</p>}
        </>
      )}
    </section>
  );
}
