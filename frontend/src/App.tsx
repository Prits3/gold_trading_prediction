import { useCallback, useState } from "react";
import { api } from "./api";
import { usePoll } from "./hooks";
import type { Conn, Horizon, InstrumentKey, RangeKey } from "./types";
import { Header } from "./components/Header";
import { PriceSummary } from "./components/PriceSummary";
import { ChartPanel, type ChartView, type ForecastTarget } from "./components/ChartPanel";
import { ForwardCard, NextSettlementCard } from "./components/ForecastCards";
import { Drawer, type DrawerTab } from "./components/Drawer";

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
  const [view, setView] = useState<ChartView>("history"); // always opens on price history
  const [horizon, setHorizon] = useStored<Horizon>("gold.horizon", 5);
  const [target, setTarget] = useState<ForecastTarget>("next");
  const [drawer, setDrawer] = useState<{ open: boolean; tab: DrawerTab }>({ open: false, tab: "model" });
  const [chartConn, setChartConn] = useState<Conn>("ok");
  const [dataRev, setDataRev] = useState(0);

  const summary = usePoll(() => api.summary(instrument), instrument === "spot" ? 5000 : 15000, `summary:${instrument}:${dataRev}`);
  const today = usePoll(api.today, 20000, `today:${dataRev}`);
  const forward = usePoll(() => api.forward(horizon), 300000, `fwd:${horizon}:${dataRev}`);
  const conn: Conn = chartConn !== "ok" ? chartConn : summary.conn;
  // Spot has no forecast view: leave it rather than silently showing futures on a spot screen.
  const effView: ChartView = instrument === "spot" ? "history" : view;

  return (
    <div className="gx">
      <Header instrument={instrument} onInstrument={setInstrument} summary={summary.data} conn={conn} onSettings={() => setDrawer({ open: true, tab: "model" })} />
      <PriceSummary s={summary.data} err={summary.error} />

      <section className="gx-fsection" aria-label="Gold futures forecasts" data-testid="forecast-section">
        <div className="gx-fhead">
          <h2>Gold futures forecasts</h2>
          <span className="gx-chip">COMEX GC=F</span>
        </div>
        {instrument === "spot" && (
          <p className="gx-fnote" data-testid="futures-note">
            These forecasts are for <b>gold futures</b>, the instrument the models are trained and measured on. They have not been evaluated for spot gold and are not drawn on the spot chart.
          </p>
        )}
        <div className="gx-cards">
          <NextSettlementCard d={today.data} err={today.error} />
          <ForwardCard d={forward.data} err={forward.error} horizon={horizon} onHorizon={(h) => { setHorizon(h); if (effView === "forecast") setTarget(h); }} />
        </div>
      </section>

      <ChartPanel instrument={instrument} summary={summary.data} view={effView} onView={setView} range={range} onRange={setRange} mode={mode} onMode={setMode}
        target={target} onTarget={setTarget} today={today.data} onConn={setChartConn} conn={conn} />

      <button className="gx-link" onClick={() => setDrawer({ open: true, tab: "model" })} data-testid="open-details-2">Model details, methodology & data →</button>
      <footer className="gx-footer">
        For information only — not investment advice. Forecasts are statistical estimates; the price may differ. Charts: <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™</a>.
      </footer>

      <Drawer open={drawer.open} tab={drawer.tab} onTab={(tab) => setDrawer({ open: true, tab })} onClose={() => setDrawer((d) => ({ ...d, open: false }))} onDataChanged={() => setDataRev((n) => n + 1)} />
    </div>
  );
}
