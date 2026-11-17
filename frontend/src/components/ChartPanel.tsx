import { useState } from "react";
import { usePoll } from "../hooks";
import { api } from "../api";
import type { Conn, ForwardPayload, Horizon, InstrumentKey, MarketSummary, OhlcPayload, RangeKey, TodayPayload } from "../types";
import { INTERVAL_WORDS } from "../chartKit";
import { fmtAgo } from "../format";
import { PriceChart } from "./PriceChart";
import { ForecastChart, FORECAST_FOOT } from "./ForecastChart";

export type ChartView = "history" | "forecast";
export type ForecastTarget = "next" | Horizon;
const RANGES: RangeKey[] = ["1D", "1W", "1M", "3M", "1Y", "5Y"];
const TARGETS: { id: ForecastTarget; label: string }[] = [{ id: "next", label: "Next settlement" }, { id: 1, label: "1 session" }, { id: 5, label: "5 sessions" }, { id: 20, label: "20 sessions" }];

export function ChartPanel({ instrument, summary, view, onView, range, onRange, mode, onMode, target, onTarget, today, onConn, conn }: {
  instrument: InstrumentKey; summary: MarketSummary | null; view: ChartView; onView: (v: ChartView) => void; range: RangeKey; onRange: (r: RangeKey) => void;
  mode: "line" | "candles"; onMode: (m: "line" | "candles") => void; target: ForecastTarget; onTarget: (t: ForecastTarget) => void;
  today: TodayPayload | null; onConn: (c: Conn) => void; conn: Conn;
}) {
  const [meta, setMeta] = useState<OhlcPayload | null>(null);
  const [info, setInfo] = useState(false);
  const forecastOn = view === "forecast" && instrument === "futures";
  // The chart's own forward forecast (independent of the card's selector) - read from the ledger, so it never changes with quotes.
  const fwd = usePoll<ForwardPayload>(() => api.forward(target === "next" ? 5 : target), 300000, `chartfwd:${target}`, forecastOn && target !== "next");
  const fc = target === "next" ? today?.forecast ?? null : fwd.data?.forecast ?? null;
  const res = target === "next" ? today?.result ?? null : fwd.data?.result ?? null;

  const word = meta ? INTERVAL_WORDS[meta.interval] ?? meta.interval : "";
  const delay = meta?.delay_seconds;
  const st = summary?.status;
  const feed = conn === "offline" ? "Offline" : conn === "reconnecting" ? "Reconnecting…" : st ? st.label : "…";
  const hint = forecastOn
    ? FORECAST_FOOT
    : meta?.time_kind === "day" ? `Each ${mode === "line" ? "point is a " : "candle is a "}${word} ${mode === "line" ? "close" : "(open, high, low, close)"}.`
      : mode === "line" ? `Each point is a ${word} close.` : `Each candle covers 5 minutes: open, high, low, close.`.replace("5 minutes", word === "5-minute" ? "5 minutes" : `one ${word.replace("-", " ")} period`);

  return (
    <section className="gx-chartcard" aria-label="Chart">
      <div className="gx-controls">
        <div className="gx-seg" role="tablist" aria-label="Chart view">
          <button role="tab" aria-selected={view === "history"} className={view === "history" ? "on" : ""} onClick={() => onView("history")} data-testid="view-history">Price history</button>
          <button role="tab" aria-selected={view === "forecast"} className={view === "forecast" ? "on" : ""} disabled={instrument !== "futures"}
            title={instrument === "futures" ? "Show a forecast target on the chart" : "Forecasts are for gold futures. Switch to Gold futures to see them on the chart."} onClick={() => onView("forecast")} data-testid="view-forecast">Forecast</button>
        </div>
        <div className="gx-controls-right">
          <div className="gx-seg" role="tablist" aria-label="Chart type">
            {(["candles", "line"] as const).map((m) => <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => onMode(m)} data-testid={`mode-${m}`}>{m === "candles" ? "Candles" : "Line"}</button>)}
          </div>
          <button className={`gx-icon sm ${info ? "on" : ""}`} aria-expanded={info} aria-label="About this data" onClick={() => setInfo(!info)} data-testid="chart-info">i</button>
        </div>
      </div>
      <div className="gx-controls sub">
        {forecastOn ? (
          <div className="gx-seg" role="tablist" aria-label="Forecast target">
            {TARGETS.map((t) => <button key={String(t.id)} role="tab" aria-selected={target === t.id} className={target === t.id ? "on" : ""} onClick={() => onTarget(t.id)} data-testid={`target-${t.id}`}>{t.label}</button>)}
          </div>
        ) : (
          <div className="gx-seg" role="tablist" aria-label="Range">
            {RANGES.map((r) => <button key={r} role="tab" aria-selected={range === r} className={range === r ? "on" : ""} onClick={() => onRange(r)} data-testid={`range-${r}`}>{r}</button>)}
          </div>
        )}
        <span className="gx-feed" data-testid="feed-status"><i className={`gx-dot ${st?.state === "live" ? "ok" : st?.state === "delayed" ? "warn" : st?.state === "stale" ? "bad" : "off"}`} />{feed}{summary ? ` · refreshes every ${summary.update_every_seconds >= 15 ? 15 : summary.update_every_seconds} s` : ""}</span>
      </div>
      {info && meta && (
        <div className="gx-infopanel" data-testid="chart-info-panel">
          <p><b>Source:</b> {meta.source}. {delay != null && delay > 120 ? `This feed is about ${Math.round(delay / 60)} minutes behind the market and is not real-time.` : delay != null ? `Last tick ${fmtAgo(delay)}.` : ""}</p>
          <p><b>Session:</b> {summary?.session.convention}</p>
          <p><b>Gaps:</b> {meta.gap_policy}</p>
          <p><b>Time zone:</b> all times are New York (ET).</p>
        </div>
      )}
      {forecastOn
        ? <ForecastChart sel={target} forecast={fc} result={res} mode={mode} onMeta={setMeta} onConn={onConn} />
        : <PriceChart instrument={instrument} range={range} mode={mode} onMeta={setMeta} onConn={onConn} />}
      <p className="gx-foot" data-testid="chart-foot">{hint}</p>
    </section>
  );
}
