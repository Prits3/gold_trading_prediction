import type { CalibrationInfo, ForecastResult, ForwardPayload, FrozenForecast, Horizon, TodayPayload } from "./types";
import { etDate, fmtEt, num, signed, timeBoth } from "./format";

export type ForecastTarget = "next" | Horizon;
export type ShownPayload = TodayPayload | ForwardPayload;
/** A forecast as the user asked for it: one explicit Predict click, with the exact stored forecast it returned. Nothing here is recomputed from settings. */
export interface Shown { target: ForecastTarget; payload: ShownPayload; fetchedAt: number }

export const usd = (v: number) => `$${num(v)}`;
export const TARGETS: { id: ForecastTarget; label: string }[] = [{ id: "next", label: "Next settlement" }, { id: 1, label: "1 session" }, { id: 5, label: "5 sessions" }, { id: 20, label: "20 sessions" }];
export const targetName = (t: ForecastTarget) => (t === "next" ? "Next settlement" : `${t}-session forecast`);

const tgtMs = (f: FrozenForecast) => Date.parse(f.target_time);
/** "Wed 18 Nov · 13:30 New York · 19:30 Berlin" */
export const targetLine = (f: FrozenForecast) => `${etDate(tgtMs(f))} · ${timeBoth(tgtMs(f))}`;
export const issuedLine = (f: FrozenForecast) => `${etDate(f.issued_at * 1000)}, ${timeBoth(f.issued_at * 1000)}`;
export const baseDate = (iso?: string) => (iso ? etDate(Date.parse(iso + "T12:00:00Z"), true) : "the base session");

/** What the reference price is, in words, for each kind of forecast. */
export function referenceText(target: ForecastTarget, f: FrozenForecast, baseDateIso?: string): string {
  return target === "next"
    ? `the latest futures price when issued, ${fmtEt(f.input_cutoff, { hour: "2-digit", minute: "2-digit", hour12: false })} New York`
    : `the official settlement of ${baseDate(baseDateIso)}`;
}

/** The single concise performance note beside the result. Full evidence is in Details. */
export function perfNote(target: ForecastTarget, p: ShownPayload): string {
  if (target === "next") {
    const c = (p as TodayPayload).calibration;
    return c?.historical_pct != null && c.n_dates
      ? `The range held the real settlement ${num(c.historical_pct, 0)}% of ${c.n_dates} past sessions. No model has beaten "price stays put" intraday.`
      : "No measured track record yet. No model has beaten \"price stays put\" intraday.";
  }
  const ev = (p as ForwardPayload).evaluation;
  const dev = ev?.development, fwd = ev?.forward;
  return `${dev ? `Backtest: ${signed(dev.mae_vs_baseline_pct, 1)}% error vs assuming no change.` : ""} ${fwd?.n_matured ? `Live: ${fwd.n_matured} scored.` : "Live: none scored yet."}${dev && dev.mae_vs_baseline_pct > -2 ? " No demonstrated advantage over assuming the price stays put." : ""}`.trim();
}

/** "80% target range · historical coverage 70%": under-calibrated ranges say "target range", well-calibrated ones just "range". */
export function coverageLine(f: FrozenForecast, c?: CalibrationInfo): { text: string; label: string | null } {
  const lvl = Math.round(f.level * 100), hist = c?.historical_pct;
  const under = !!c?.label;
  return { text: hist != null ? `${lvl}% ${under ? "target range" : "range"} · historical coverage ${num(hist, 0)}%` : `${lvl}% range · historical coverage not yet measured`, label: c?.label ?? null };
}

export const resultLine = (r?: ForecastResult | null) =>
  r?.matured ? `Actual ${usd(r.actual!)}, off by $${num(r.abs_error!)}${r.in_range != null ? (r.in_range ? ", inside the range" : ", outside the range") : ""}.` : "The target time has passed; the official figure is not posted yet.";

/** Which history ranges can show a forecast to this target without being mostly blank or hiding the origin. */
export const FIT_RANGES: Record<string, string[]> = { next: ["1D", "1W"], "1": ["1W", "1M", "3M"], "5": ["3M", "1Y"], "20": ["3M", "1Y"] };
export const DEFAULT_RANGE: Record<string, string> = { next: "1D", "1": "1M", "5": "3M", "20": "3M" };
export const FORECAST_FOOT = "The dashed line only connects the forecast reference to the target; it is illustrative and is not a predicted path. The bar at the target is the forecast range.";
