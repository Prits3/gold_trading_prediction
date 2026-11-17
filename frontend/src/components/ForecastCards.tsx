import type { MouseEvent } from "react";
import type { CalibrationInfo, ForecastResult, ForwardPayload, FrozenForecast, Horizon, TodayPayload } from "../types";
import { arrow, dirClass, etDate, fmtEt, num, pct, signed, timeBoth } from "../format";
import { Info } from "./Common";

const usd = (v: number) => `$${num(v)}`;
const tgtMs = (f: FrozenForecast) => Date.parse(f.target_time);
/** "Wed 18 Nov · 13:30 New York · 19:30 Berlin" */
export const targetLine = (f: FrozenForecast) => `${etDate(tgtMs(f))} · ${timeBoth(tgtMs(f))}`;
const issuedLine = (f: FrozenForecast) => `${etDate(f.issued_at * 1000)}, ${timeBoth(f.issued_at * 1000)}`;
export const baseDate = (iso?: string) => (iso ? etDate(Date.parse(iso + "T12:00:00Z"), true) : "the base session");

/** Range line. Under-calibrated ranges say so in the words the spec asks for: "80% target range · historical coverage 70%". */
function RangeBlock({ f, c }: { f: FrozenForecast; c?: CalibrationInfo }) {
  const lvl = Math.round(f.level * 100);
  const hist = c?.historical_pct;
  const under = !!c?.label;
  return (
    <div className="gx-range" data-testid="calibration">
      <div className="gx-rangeline">Prediction range: <b className="mono">{usd(f.low)}–{usd(f.high)}</b></div>
      <div className="gx-micro">
        {hist != null ? `${lvl}% ${under ? "target range" : "range"} · historical coverage ${num(hist, 0)}%` : `${lvl}% range · historical coverage not yet measured`}
        {under && <span className="gx-warn" data-testid="calibration-label">{c!.label}</span>}
      </div>
    </div>
  );
}

function Body({ f, cal, reference, referenceKind, result, completed, perf, tail, isNext }: {
  f: FrozenForecast; cal?: CalibrationInfo; reference: string; referenceKind: string; result?: ForecastResult | null; completed: boolean; perf?: string; tail?: React.ReactNode; isNext?: boolean;
}) {
  const isBase = f.source.kind === "baseline";
  const dir = dirClass(f.change);
  return (
    <>
      <div className="gx-pricerow">
        <div className="gx-big mono" data-testid={isNext ? "today-pred" : "fwd-pred"}>{usd(f.predicted)}</div>
        <span className={`gx-chip ${isBase ? "base" : ""}`} data-testid="source-chip">{isBase ? "Unchanged-price baseline" : "Model forecast"}</span>
      </div>
      <div className="gx-when" data-testid={isNext ? "today-target" : "fwd-target"}>{targetLine(f)}</div>
      <div className={`gx-sub mono ${f.little_change ? "flat" : dir}`} data-testid={isNext ? "today-vs" : "fwd-change"}>
        {f.little_change
          ? <>Little change predicted<Info label="Little change" text={`Shown when the predicted move is smaller than ${num(f.little_change_threshold_pct, 2)}% (0.10% × √sessions). A display rule only, not a confidence level and not an edge.`} /></>
          : <><span aria-hidden="true">{arrow(f.change)}</span> {pct(f.change_pct)} versus {referenceKind}</>}
      </div>
      <div className="gx-ref" data-testid={isNext ? "today-ref" : "fwd-ref"}>
        Reference <b className="mono">{usd(f.reference_price)}</b> · {reference} · change <span className="mono">{f.change < 0 ? "−" : "+"}${num(Math.abs(f.change))}</span>
      </div>
      {isBase && <p className="gx-micro" data-testid={isNext ? "today-sentence" : "fwd-sentence"}>Equals the price when issued. No model is in control of this target, so nothing is predicted beyond the range.</p>}
      <RangeBlock f={f} c={cal} />
      <div className="gx-issued" data-testid="issued">Issued {issuedLine(f)}</div>
      {perf && <p className="gx-micro gx-perf" data-testid={isNext ? "today-perf" : "fwd-perf"}>{perf}</p>}
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

/** Selecting a card (anywhere that is not a control) shows its target on the Forecast chart. */
function pick(onSelect: () => void) {
  return (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("button, a, .info")) onSelect(); };
}

function ShowOnChart({ selected, onSelect, canShow, id }: { selected: boolean; onSelect: () => void; canShow: boolean; id: string }) {
  if (!canShow) return null;
  return <button className={`gx-show ${selected ? "on" : ""}`} aria-pressed={selected} onClick={onSelect} data-testid={`show-${id}`}>{selected ? "Shown on chart" : "Show on chart"}</button>;
}

export function NextSettlementCard({ d, err, selected, onSelect, canShow, onDetails }: {
  d: TodayPayload | null; err: string | null; selected: boolean; onSelect: () => void; canShow: boolean; onDetails: () => void;
}) {
  if (!d) return <section className="gx-card" data-testid="today-card"><h2>NEXT SETTLEMENT</h2><p className="gx-muted">{err ?? "Loading forecast…"}</p></section>;
  const f = d.forecast;
  const completed = d.status === "completed";
  const c = d.calibration;
  const perf = c?.historical_pct != null && c.n_dates ? `The range held the real settlement ${num(c.historical_pct, 0)}% of ${c.n_dates} past sessions. No model has beaten "price stays put" intraday.` : undefined;
  return (
    <section className={`gx-card selectable ${selected ? "selected" : ""}`} aria-label="Next settlement forecast" data-testid="today-card" data-status={d.status} data-selected={selected} onClick={canShow ? pick(onSelect) : undefined}>
      <div className="gx-card-head"><h2>NEXT SETTLEMENT</h2><span className="gx-chip">Gold futures</span></div>
      {!f ? <p className="gx-muted">{d.message}</p> : (
        <Body f={f} cal={c} isNext completed={completed} result={d.result} perf={perf}
          reference={`the latest futures price when issued, ${fmtEt(f.input_cutoff, { hour: "2-digit", minute: "2-digit", hour12: false })} New York`} referenceKind="the price when issued"
          tail={<>
            {d.live && !completed && (
              <p className="gx-live" data-testid="live-compare">
                <b>Latest futures quote</b> (separate from the forecast): <span className="mono">{usd(d.live.price)}</span>{d.live.delay_seconds > 120 ? ` · ~${Math.round(d.live.delay_seconds / 60)} min delayed` : ""} ·{" "}
                <span className={`mono ${dirClass(d.live.vs_forecast)}`}>{signed(d.live.vs_forecast)} vs this forecast</span>
              </p>
            )}
            <p className="gx-micro">{completed ? d.message : d.next_update_epoch ? `Next forecast ${fmtEt(d.next_update_epoch, { hour: "2-digit", minute: "2-digit", hour12: false })} New York (hourly while the market is open).` : "Market closed: no new forecast until it reopens."}</p>
            {d.last_result && d.last_result.status === "awaiting_official_figure" && <p className="gx-micro">Previous settlement ({d.last_result.target_date}): predicted {usd(d.last_result.predicted)}; official figure not posted yet.</p>}
            <div className="gx-cardfoot"><ShowOnChart id="next" selected={selected} onSelect={onSelect} canShow={canShow} /><button className="gx-textbtn" onClick={onDetails} data-testid="details-next">Model details</button></div>
          </>} />
      )}
    </section>
  );
}

export function ForwardCard({ d, err, horizon, onHorizon, selected, onSelect, canShow, onDetails }: {
  d: ForwardPayload | null; err: string | null; horizon: Horizon; onHorizon: (h: Horizon) => void; selected: boolean; onSelect: () => void; canShow: boolean; onDetails: () => void;
}) {
  const f = d?.forecast;
  const completed = d?.status === "completed";
  const ev = d?.evaluation;
  const dev = ev?.development, fwd = ev?.forward;
  const perf = ev ? `${dev ? `Backtest: ${signed(dev.mae_vs_baseline_pct, 1)}% error vs assuming no change.` : ""} ${fwd?.n_matured ? `Live: ${fwd.n_matured} scored.` : "Live: none scored yet."}${dev && dev.mae_vs_baseline_pct > -2 ? " No demonstrated advantage over assuming the price stays put." : ""}`.trim() : undefined;
  return (
    <section className={`gx-card selectable ${selected ? "selected" : ""}`} aria-label="Forward forecast" data-testid="forward-card" data-status={d?.status ?? "loading"} data-selected={selected} onClick={canShow ? pick(onSelect) : undefined}>
      <div className="gx-card-head">
        <h2>{horizon}-SESSION FORECAST</h2><span className="gx-chip">Gold futures</span>
        <div className="gx-seg sm" role="tablist" aria-label="Horizon" style={{ marginLeft: "auto" }}>
          {([1, 5, 20] as const).map((h) => (
            <button key={h} role="tab" aria-selected={horizon === h} className={horizon === h ? "on" : ""} onClick={() => onHorizon(h)} data-testid={`h-${h}`}>{h}{h === 1 ? " session" : " sessions"}</button>
          ))}
        </div>
      </div>
      {!d ? <p className="gx-muted">{err ?? "Loading forecast…"}</p> : !f ? (
        <p className="gx-muted gx-explain" data-testid="fwd-none">{d.message ?? err}</p>
      ) : (
        <Body f={f} cal={d.calibration} completed={completed} result={d.result} perf={perf}
          reference={`official settlement of ${baseDate(d.base_date)}`} referenceKind="the forecast's base close"
          tail={<>
            {d.next_forecast && <p className="gx-micro gx-explain" data-testid="next-forecast">{d.next_forecast.message}</p>}
            <div className="gx-cardfoot"><ShowOnChart id="fwd" selected={selected} onSelect={onSelect} canShow={canShow} /><button className="gx-textbtn" onClick={onDetails} data-testid="details-fwd">Model details</button></div>
          </>} />
      )}
    </section>
  );
}
