import { useCallback, useMemo, useState } from "react";
import { api } from "./api";
import { usePoll } from "./hooks";
import type { Conn, Horizon, InstrumentKey, OhlcPayload, RangeKey } from "./types";
import { Header } from "./components/Header";
import { PriceSummary } from "./components/PriceSummary";
import { GoldChart, type Overlay } from "./components/GoldChart";
import { TodayCard } from "./components/TodayCard";
import { ForwardCard } from "./components/ForwardCard";
import { Drawer, type DrawerTab } from "./components/Drawer";
import { fmtAgo } from "./format";

const RANGES: RangeKey[] = ["1D", "1W", "1M", "3M", "1Y", "5Y"];
const INTRADAY = new Set<RangeKey>(["1D", "1W", "1M"]);

function useStored<T extends string | boolean | number>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw == null ? init : (JSON.parse(raw) as T); } catch { return init; }
  });
  const set = useCallback((x: T) => { setV(x); try { localStorage.setItem(key, JSON.stringify(x)); } catch { /* storage unavailable: the setting just won't persist */ } }, [key]);
  return [v, set];
}

export default function App() {
  const [instrument, setInstrument] = useStored<InstrumentKey>("gold.instrument", "futures");
  const [range, setRange] = useStored<RangeKey>("gold.range", "1D");
  const [mode, setMode] = useStored<"line" | "candles">("gold.mode", "candles");
  const [showForecast, setShowForecast] = useStored<boolean>("gold.forecast", true);
  const [horizon, setHorizon] = useStored<Horizon>("gold.horizon", 5);
  const [drawer, setDrawer] = useState<{ open: boolean; tab: DrawerTab }>({ open: false, tab: "model" });
  const [chartConn, setChartConn] = useState<Conn>("ok");
  const [meta, setMeta] = useState<OhlcPayload | null>(null);
  const [dataRev, setDataRev] = useState(0);

  const summary = usePoll(() => api.summary(instrument), instrument === "spot" ? 5000 : 15000, `summary:${instrument}:${dataRev}`);
  const today = usePoll(api.today, 20000, `today:${dataRev}`);
  const forward = usePoll(() => api.forward(horizon), 300000, `fwd:${horizon}:${dataRev}`);

  const conn: Conn = chartConn !== "ok" ? chartConn : summary.conn;
  const t = today.data, f = forward.data;
  const overlay: Overlay | null = useMemo(() => {
    if (!showForecast || instrument !== "futures") return null;
    if (INTRADAY.has(range)) {
      if (!t) return null;
      return { kind: "today", originTime: t.anchor_time_epoch, originPrice: t.anchor_price, targetTime: Math.round(Date.parse(t.target_time) / 1000), predicted: t.predicted_close, low: t.low, high: t.high, label: "Today" };
    }
    if (!f || "status" in f) return null;
    return { kind: "forward", originTime: f.base_date, originPrice: f.base_price, targetTime: f.target_date, predicted: f.predicted, low: f.low, high: f.high, label: `${f.horizon} sessions` };
  }, [showForecast, instrument, range, t, f]);

  const cadence = instrument === "spot" ? "every 10 s" : "every 15 s";
  const delay = meta?.delay_seconds;

  return (
    <div className="gx">
      <Header instrument={instrument} onInstrument={setInstrument} summary={summary.data} conn={conn} onSettings={() => setDrawer({ open: true, tab: "model" })} />
      <PriceSummary s={summary.data} err={summary.error} />

      <section className="gx-chartcard" aria-label="Price chart">
        <div className="gx-controls">
          <div className="gx-seg" role="tablist" aria-label="Range">
            {RANGES.map((r) => <button key={r} role="tab" aria-selected={range === r} className={range === r ? "on" : ""} onClick={() => setRange(r)} data-testid={`range-${r}`}>{r}</button>)}
          </div>
          <div className="gx-controls-right">
            <div className="gx-seg" role="tablist" aria-label="Chart type">
              {(["candles", "line"] as const).map((m) => <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)} data-testid={`mode-${m}`}>{m === "candles" ? "Candles" : "Line"}</button>)}
            </div>
            <button className={`gx-toggle ${showForecast && instrument === "futures" ? "on" : ""}`} aria-pressed={showForecast} disabled={instrument !== "futures"} onClick={() => setShowForecast(!showForecast)}
              title={instrument === "futures" ? "Show the forecast on the chart" : "Forecast overlays are for gold futures only"} data-testid="toggle-forecast">Forecast</button>
          </div>
        </div>
        <GoldChart instrument={instrument} range={range} mode={mode} overlay={overlay} onMeta={setMeta} onConn={setChartConn} />
        <p className="gx-foot" data-testid="chart-foot">
          {meta ? `${meta.interval} ${meta.real_ohlc ? "real OHLC" : ""} · ${meta.source} · refreshes ${cadence}${delay != null && delay > 120 ? ` · feed delayed ~${Math.round(delay / 60)} min, not real-time` : delay != null ? ` · last tick ${fmtAgo(delay)}` : ""}` : "Loading…"}
          {meta ? ` · ${meta.gap_policy}` : ""}
        </p>
      </section>

      <div className="gx-cards">
        <TodayCard d={t} err={today.error} instrument={instrument} />
        <ForwardCard d={f} err={forward.error} horizon={horizon} onHorizon={setHorizon} instrument={instrument} />
      </div>

      <button className="gx-link" onClick={() => setDrawer({ open: true, tab: "model" })} data-testid="open-details-2">Model details, methodology & data →</button>
      <footer className="gx-footer">
        For information only — not investment advice. Forecasts are statistical estimates; the price may differ. Charts: <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™</a>.
      </footer>

      <Drawer open={drawer.open} tab={drawer.tab} onTab={(tab) => setDrawer({ open: true, tab })} onClose={() => setDrawer((d) => ({ ...d, open: false }))} onDataChanged={() => setDataRev((n) => n + 1)} />
    </div>
  );
}
