import type { ForwardPayload, TodayPayload } from "../types";
import { arrow, dirClass, etDate, num, pct } from "../format";
import { api } from "../api";
import { coverageLine, issuedLine, perfNote, referenceText, resultLine, targetLine, targetName, usd, type Shown } from "../forecastText";
import { Info } from "./Common";

/** One compact strip under the chart: Predicted price | Expected change | Target date | Prediction range, plus the reference and one performance note. */
const SCHEMA_WORDS: Record<string, string> = { gold_v1: "gold inputs", drivers_v1: "+ market drivers", intraday_v1: "intraday inputs", patterns_v1: "+ chart patterns", fib_v1: "+ patterns & Fibonacci (experimental)" };

export function ResultStrip({ shown, newerId, latestPrice, onDetails }: { shown: Shown | null; newerId: string | null; latestPrice: number | null; onDetails: () => void }) {
  if (!shown) {
    return <section className="gx-strip empty" data-testid="result-strip" data-state="none"><p className="gx-muted">Choose Next settlement or a horizon, then press <b>Predict</b>. The forecast is drawn on the chart above, with its reference price, target date and range.</p></section>;
  }
  const p = shown.payload;
  const f = p.forecast!;
  const completed = p.status === "completed";
  const isBase = f.source.kind === "baseline";
  const cov = coverageLine(f, p.calibration);
  const baseIso = shown.target === "next" ? undefined : (p as ForwardPayload).base_date;
  const dir = dirClass(f.change);
  const exp = (p as TodayPayload).experimental ?? [];
  const newer = !!newerId && newerId !== f.forecast_id;
  return (
    <section className="gx-strip" data-testid="result-strip" data-state={completed ? "completed" : "current"} data-forecast-id={f.forecast_id}>
      <div className="gx-strip-head">
        <b>{targetName(shown.target)}</b>
        <span className={`gx-chip ${isBase ? "base" : ""}`} data-testid="source-chip">{isBase ? "Unchanged-price baseline" : "Model forecast"}</span>
        {completed && <span className="gx-chip warnchip" data-testid="completed-chip">Completed</span>}
        {newer && <span className="gx-chip warnchip" data-testid="newer-chip">A newer forecast exists — press Predict</span>}
      </div>
      <div className="gx-cells">
        <div className="gx-cell"><span>Predicted price</span><b className="mono" data-testid="strip-price">{usd(f.predicted)}</b></div>
        <div className="gx-cell">
          <span>Expected change</span>
          <b className={`mono ${f.little_change ? "flat" : dir}`} data-testid="strip-change">
            {f.little_change ? "Little change" : <><span aria-hidden="true">{arrow(f.change)}</span> {pct(f.change_pct)}</>}
          </b>
          <small className="mono">{f.change < 0 ? "−" : "+"}${num(Math.abs(f.change))}{f.little_change && <Info label="Little change" text={`Shown when the predicted move is smaller than ${num(f.little_change_threshold_pct, 2)}% (0.10% × √sessions). A display rule only, not a confidence level and not an edge.`} />}</small>
        </div>
        <div className="gx-cell"><span>Target date</span><b data-testid="strip-target">{etDate(Date.parse(f.target_time), true)}</b><small>{targetLine(f).split(" · ").slice(1).join(" · ")}</small></div>
        <div className="gx-cell">
          <span>Prediction range</span><b className="mono" data-testid="strip-range">{usd(f.low)}–{usd(f.high)}</b>
          <small data-testid="calibration">{cov.text}{cov.label && <em className="gx-warn" data-testid="calibration-label">{cov.label}</em>}</small>
        </div>
      </div>
      <p className="gx-ref" data-testid="strip-ref">Reference <b className="mono">{usd(f.reference_price)}</b> · {referenceText(shown.target, f, baseIso)} · issued {issuedLine(f)}</p>
      {latestPrice != null && !completed && (
        <p className="gx-micro" data-testid="strip-latest">Latest futures quote (separate from the forecast): <span className="mono">{usd(latestPrice)}</span> · <span className={`mono ${dirClass(latestPrice - f.predicted)}`}>{latestPrice - f.predicted < 0 ? "−" : "+"}${num(Math.abs(latestPrice - f.predicted))} vs this forecast</span>.</p>
      )}
      {isBase && <p className="gx-micro" data-testid="strip-sentence">Equals the price when issued. No model is in control of this target, so nothing is predicted beyond the range.</p>}
      {completed && <p className="gx-completed" data-testid="completed-banner"><b>Completed</b> — {resultLine(p.result)}</p>}
      {exp.length > 0 && (
        <p className="gx-micro" data-testid="strip-experimental">
          <b>Experimental model estimates</b> (shadow: recorded before the outcome, not in control of this forecast): {exp.map((e) => `${e.label.replace(" model", "")} (${SCHEMA_WORDS[e.feature_schema] ?? e.feature_schema}) ${usd(e.predicted)}`).join(" · ")}. None has shown an advantage over the unchanged price.
        </p>
      )}
      <div className="gx-strip-foot">
        <p className="gx-micro gx-perf" data-testid="strip-perf">{perfNote(shown.target, p)}</p>
        <div className="gx-strip-actions">
          <a className="gx-textbtn" href={api.exportForecastUrl(f.forecast_id)} download data-testid="download">Download CSV</a>
          <button className="gx-textbtn" onClick={onDetails} data-testid="details-link">Details</button>
        </div>
      </div>
    </section>
  );
}
