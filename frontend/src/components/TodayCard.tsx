import type { InstrumentKey, TodayForecast } from "../types";
import { dirClass, fmtEt, fmtEtDay, fmtEtShort, fmtIsoEt, num, pct, signed } from "../format";
import { Info } from "./Common";

const left = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

export function TodayCard({ d, err, instrument }: { d: TodayForecast | null; err: string | null; instrument: InstrumentKey }) {
  if (!d) return <section className="gx-card" data-testid="today-card"><h2>Today's prediction</h2><p className="gx-muted">{err ?? "Loading forecast…"}</p></section>;
  const diff = d.predicted_close - d.reference.price;
  const diffPct = (d.predicted_close / d.reference.price - 1) * 100;
  const next = d.phase === "next_session";
  const lr = d.last_result;
  const cal = d.calibration;
  return (
    <section className="gx-card" aria-label="Today's prediction" data-testid="today-card">
      <div className="gx-card-head">
        <h2>{next ? "Next settlement prediction" : "Today's prediction"}</h2>
        <span className="gx-chip">Futures · GC=F</span>
        <Info label="Today's prediction" text="Forecast of the next official COMEX gold futures settlement (13:30 New York time), made from the latest futures price. No machine-learning model has beaten 'the price stays put' on held-out evidence, so the estimate equals the latest price; the range is what carries the information, and it narrows as the settlement approaches." />
      </div>
      {next && <p className="gx-note">Today's settlement has passed. This is the next session's prediction.</p>}
      <div className="gx-big mono" data-testid="today-pred">{num(d.predicted_close)}</div>
      <div className={`gx-sub mono ${dirClass(diff)}`} data-testid="today-vs">
        {signed(diff)} ({pct(diffPct)}) <span className="gx-muted">vs {d.reference.label} {num(d.reference.price)}</span>
      </div>
      <dl className="gx-facts">
        <div><dt>Target</dt><dd>{d.target_label} · {fmtIsoEt(d.target_time, { weekday: "short", day: "numeric", month: "short", year: "numeric" })} · ET{d.minutes_to_target > 0 ? ` · in ${left(d.minutes_to_target)}` : ""}</dd></div>
        <div><dt>{Math.round(d.level * 100)}% range</dt><dd className="mono">{num(d.low)} – {num(d.high)}</dd></div>
        <div><dt>Issued</dt><dd className="mono">{d.issued_at ? `${fmtEtShort(d.issued_at)} ET` : "pending"}{d.next_update_epoch ? ` · next update ${fmtEtShort(d.next_update_epoch)} ET` : " · market closed, no update scheduled"}</dd></div>
      </dl>
      {lr && (
        <div className="gx-result" data-testid="last-result">
          <b>Last result ({fmtEtDay(Date.parse(lr.target_date + "T12:00:00Z") / 1000)}):</b>{" "}
          {lr.status === "scored"
            ? <>predicted <span className="mono">{num(lr.predicted)}</span> → actual <span className="mono">{num(lr.actual!)}</span> · off by <span className="mono">${num(lr.abs_error!)}</span>{lr.in_range != null ? (lr.in_range ? " · inside the range" : " · outside the range") : ""}</>
            : <>predicted <span className="mono">{num(lr.predicted)}</span> · waiting for the official figure</>}
        </div>
      )}
      <p className="gx-perf" data-testid="today-perf">
        Tested on {cal.n_sessions} sessions: the range held {num(cal.coverage_by_session_pct, 0)}% of the time (90% interval {num(cal.coverage_ci90_pct[0], 0)}–{num(cal.coverage_ci90_pct[1], 0)}%).
        {" "}Live record: {d.evaluation.n_matured ? `${d.evaluation.n_matured} scored` : "none scored yet"}.
        {d.typical_error_usd != null ? ` Typical miss at this point of the day ≈ $${num(d.typical_error_usd, 1)}.` : ""}
      </p>
      {instrument === "spot" && <p className="gx-note">Shown for gold futures. Spot has no separately evaluated model, so these numbers are not claimed for spot.</p>}
      {!d.market_open && <p className="gx-note">Market closed. Latest futures trade {fmtEt(d.anchor_time_epoch, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })} ET.</p>}
    </section>
  );
}
