import { useEffect, useRef, useState } from "react";
import { AreaSeries, CandlestickSeries, LineSeries, LineStyle, LineType, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time } from "lightweight-charts";
import { api } from "../api";
import type { Bar, Conn, ForecastResult, FrozenForecast, Horizon, OhlcPayload } from "../types";
import { C, INTERVAL_WORDS, STEP, byTime, futureSlots, makeChart, timeLabel } from "../chartKit";
import { resolveLabels, type LabelIn, type LabelOut } from "../labels";
import { fmtEt, fmtIsoEt, num } from "../format";

const POLL_MS = 15000;
const etDay = (epochSec: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(epochSec * 1000));
const textW = (s: string, px = 6.7) => Math.ceil(s.length * px + 18);

interface Pt { x: number; y: number }
interface Geometry { w: number; h: number; labels: (LabelOut & { text: string; sub?: string; sub2?: string; kind: string })[]; bar: { x: number; y1: number; y2: number } | null }

/**
 * The Forecast view. Recent history, a labelled reference point, an "illustrative connection" to the target, and the target with its
 * range at its real date. The context window is chosen so the target fits without the chart being mostly blank. Labels are placed by a
 * collision resolver (they move; the plotted prices never do) and never clip.
 */
export function ForecastChart({ sel, forecast, result, mode, onMeta, onConn }: {
  sel: "next" | Horizon; forecast: FrozenForecast | null; result: ForecastResult | null; mode: "line" | "candles";
  onMeta?: (m: OhlcPayload) => void; onConn?: (c: Conn) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const area = useRef<ISeriesApi<"Area"> | null>(null);
  const connector = useRef<ISeriesApi<"Line"> | null>(null);
  const pts = useRef<Record<string, ISeriesApi<"Line"> | null>>({});
  const mk = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const barMap = useRef<Map<number | string, Bar>>(new Map());
  const meta = useRef<OhlcPayload | null>(null);
  const win = useRef<{ lastTime: number | string; originKey: number | string; targetKey: number | string } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errText, setErrText] = useState<string | null>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const fRef = useRef(forecast); fRef.current = forecast;
  const rRef = useRef(result); rRef.current = result;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const chart = makeChart(el);
    candles.current = chart.addSeries(CandlestickSeries, { upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down, lastValueVisible: false, priceLineVisible: false });
    area.current = chart.addSeries(AreaSeries, { lineColor: C.accent, lineWidth: 2, lineType: LineType.Simple, topColor: "rgba(214,184,120,0.16)", bottomColor: "rgba(214,184,120,0)", lastValueVisible: false, priceLineVisible: false });
    connector.current = chart.addSeries(LineSeries, { color: C.accent, lineStyle: LineStyle.Dashed, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    const dot = (color: string, r: number) => chart.addSeries(LineSeries, { color, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: r, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    pts.current = { pred: dot(C.accent, 5), low: dot(C.muted, 3), high: dot(C.muted, 3), actual: dot(C.line, 4) };
    mk.current = createSeriesMarkers(connector.current, []);
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, []);

  /** Lay the window out: history that ends at the latest observation, empty slots up to the target, overlay series. */
  const draw = (fit: boolean) => {
    const m = meta.current, f = fRef.current;
    if (!m || !candles.current || !area.current) return;
    const bars = [...barMap.current.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    if (!bars.length) return;
    const kind = m.time_kind, step = STEP[m.interval] ?? 3600;
    const lastTime = bars[bars.length - 1].time;
    for (const s of [connector.current, ...Object.values(pts.current)]) s?.setData([]);
    mk.current?.setMarkers([]);
    let visible = bars.slice(-(sel === "next" ? 56 : 45));
    win.current = null;
    if (f) {
      const targetKey: number | string = kind === "epoch" ? Math.round(Date.parse(f.target_time) / 1000) : f.target_date;
      let originKey: number | string = kind === "epoch" ? Math.floor(f.input_cutoff / step) * step : etDay(f.input_cutoff);
      if (originKey > lastTime) originKey = lastTime; // the forecast is newer than the (delayed) chart data
      if (originKey < bars[0].time) originKey = bars[0].time;
      const slots = targetKey > lastTime ? futureSlots(lastTime, targetKey, kind, m.interval).filter((x) => x.time > lastTime && x.time < targetKey) : [];
      const K = slots.length + 1;
      const originIdx = Math.max(0, bars.findIndex((b) => b.time >= originKey));
      const hist = Math.min(bars.length, Math.max(sel === "next" ? 48 : 30, Math.ceil(2.2 * K), bars.length - originIdx + 6));
      visible = bars.slice(-hist);
      const first = visible[0].time;
      if (originKey < first) originKey = first;
      // The connector needs strictly ascending times. If a (corrupt) forecast has its target at or before its origin, draw only the target.
      const line = originKey < targetKey ? [{ time: originKey as Time, value: f.reference_price }, ...slots.filter((x) => x.time > originKey && x.time < targetKey), { time: targetKey as Time, value: f.predicted }] : [];
      connector.current!.setData(line as never);
      pts.current.pred!.setData([{ time: targetKey as Time, value: f.predicted }]);
      pts.current.low!.setData([{ time: targetKey as Time, value: f.low }]);
      pts.current.high!.setData([{ time: targetKey as Time, value: f.high }]);
      const r = rRef.current;
      if (r?.matured && r.actual != null) pts.current.actual!.setData([{ time: targetKey as Time, value: r.actual }]);
      if (originKey < targetKey) mk.current?.setMarkers([{ time: originKey as Time, position: "inBar", shape: "circle", color: C.accent, size: 1 }]);
      win.current = { lastTime, originKey, targetKey };
    }
    candles.current.setData(byTime(visible.map((b) => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close }))) as never);
    area.current.setData(byTime(visible.map((b) => ({ time: b.time as Time, value: b.close }))) as never);
    if (fit) chartRef.current?.timeScale().fitContent();
  };

  useEffect(() => {
    let dead = false;
    setState("loading"); setErrText(null); setGeo(null); barMap.current = new Map(); meta.current = null;
    api.ohlc("futures", sel === "next" ? "1W" : "1Y").then((d) => {
      if (dead) return;
      meta.current = d;
      barMap.current = new Map(d.bars.map((b) => [b.time, b]));
      onMeta?.(d); onConn?.("ok");
      setState("ready");
      draw(true);
    }).catch((e) => { if (!dead) { setState("error"); setErrText(e instanceof Error ? e.message : "Could not load the chart."); onConn?.("reconnecting"); } });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // A newly issued forecast (or its outcome) redraws the overlay once; quote updates never do.
  useEffect(() => { if (state === "ready") draw(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [forecast?.forecast_id, result?.matured, state]);

  // Live bars: update() the newest candle only. The forecast and its window are unaffected, and zoom is preserved.
  useEffect(() => {
    const id = window.setInterval(async () => {
      if (document.hidden || !meta.current) return;
      const tail = [...barMap.current.values()].slice(-3)[0];
      const since = typeof tail?.time === "number" ? tail.time - 1 : Date.now() / 1000 - 8 * 86400;
      try {
        const d = await api.ohlc("futures", sel === "next" ? "1W" : "1Y", since);
        const last = win.current?.lastTime;
        for (const b of [...d.bars].sort((x, y) => (x.time < y.time ? -1 : x.time > y.time ? 1 : 0))) {
          if (last != null && b.time < last) continue;
          const old = barMap.current.get(b.time);
          if (old && old.open === b.open && old.high === b.high && old.low === b.low && old.close === b.close) continue;
          barMap.current.set(b.time, b);
          candles.current?.update({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close });
          area.current?.update({ time: b.time as Time, value: b.close });
          if (win.current) win.current.lastTime = b.time;
        }
        meta.current = { ...meta.current!, delay_seconds: d.delay_seconds };
        onMeta?.(meta.current); onConn?.("ok");
      } catch { onConn?.(navigator.onLine === false ? "offline" : "reconnecting"); }
    }, POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  useEffect(() => { candles.current?.applyOptions({ visible: mode === "candles" }); area.current?.applyOptions({ visible: mode === "line" }); }, [mode]);

  // Label geometry: recomputed ~8x/s from the chart's own coordinates, so labels follow zoom, scroll and resize.
  useEffect(() => {
    const id = window.setInterval(() => {
      const chart = chartRef.current, el = box.current, f = fRef.current, w = win.current, ser = candles.current;
      if (!chart || !el || !f || !w || !ser) return;
      const ts = chart.timeScale();
      const X = (t: number | string) => ts.timeToCoordinate(t as Time);
      const Y = (p: number) => ser.priceToCoordinate(p);
      const lastBar = [...barMap.current.values()].sort((a, b) => (a.time < b.time ? -1 : 1)).slice(-1)[0];
      const lx = X(w.lastTime), ly = lastBar ? Y(lastBar.close) : null;
      const ox = X(w.originKey), oy = Y(f.reference_price);
      const tx = X(w.targetKey), yp = Y(f.predicted), yl = Y(f.low), yh = Y(f.high);
      const axis = (() => { try { return chart.priceScale("right").width(); } catch { return 0; } })();
      const W = el.clientWidth - axis, H = el.clientHeight;  // labels live in the plot area only, never over the price axis
      if ([lx, ly, ox, oy, tx, yp, yl, yh].some((v) => v == null)) return setGeo((g) => (g ? null : g));
      const narrow = W < 460;
      const items: (LabelIn & { text: string; sub?: string; sub2?: string; kind: string })[] = [];
      const add = (id: string, p: Pt, side: LabelIn["side"], text: string, sub: string | undefined, dy: number, kind: string, sub2?: string) =>
        items.push({ id, x: p.x, y: p.y, w: Math.max(textW(text), sub ? textW(sub, 5.6) : 0, sub2 ? textW(sub2, 5.6) : 0), h: sub2 ? 50 : sub ? 36 : 22, side, dy, text, sub, sub2, kind });
      const up = f.predicted >= f.reference_price;
      add("latest", { x: lx!, y: ly! }, "right", `Latest ${num(lastBar.close)}`, undefined, 0, "hist");
      add("ref", { x: ox!, y: oy! }, "right", `Reference ${num(f.reference_price)}`, narrow ? undefined : "when issued", up ? 30 : -30, "ref");
      // The target's date and time sit ON its price label, so the target date is never disconnected from its price.
      const when = `${fmtIsoEt(f.target_time, { weekday: "short", day: "numeric", month: "short" })} · ${fmtIsoEt(f.target_time, { hour: "2-digit", minute: "2-digit", hour12: false })} New York`;
      add("forecast", { x: tx!, y: yp! }, "right", num(f.predicted), when, up ? -34 : 34, "forecast", f.source.kind === "baseline" ? "Unchanged-price baseline" : "Model forecast");
      add("high", { x: tx!, y: yh! }, "right", `${Math.round(f.level * 100)}% high ${num(f.high)}`, undefined, -4, "range");
      add("low", { x: tx!, y: yl! }, "right", `${Math.round(f.level * 100)}% low ${num(f.low)}`, undefined, 4, "range");
      add("conn", { x: (ox! + tx!) / 2, y: (oy! + yp!) / 2 }, "center", "Illustrative connection", undefined, up ? 16 : -16, "conn");
      const r = rRef.current;
      if (r?.matured && r.actual != null && Y(r.actual) != null) add("actual", { x: tx!, y: Y(r.actual)! }, "right", `Actual ${num(r.actual)}`, undefined, 0, "actual");
      const labels = resolveLabels(items, { width: W, height: H }) as Geometry["labels"];
      for (const l of labels) { const src = items.find((i) => i.id === l.id)!; l.text = src.text; l.sub = src.sub; l.sub2 = src.sub2; l.kind = src.kind; }
      setGeo((prev) => {
        const next: Geometry = { w: W, h: H, labels, bar: { x: tx!, y1: yh!, y2: yl! } };
        return prev && prev.w === W && prev.h === H && prev.bar?.x === next.bar!.x && prev.bar?.y1 === next.bar!.y1 && prev.bar?.y2 === next.bar!.y2 &&
          prev.labels.every((p, i) => p.left === labels[i]?.left && p.top === labels[i]?.top && p.text === labels[i]?.text) ? prev : next;
      });
    }, 120);
    return () => window.clearInterval(id);
  }, [sel, forecast?.forecast_id, result?.matured]);

  const word = meta.current ? INTERVAL_WORDS[meta.current.interval] ?? meta.current.interval : "";
  return (
    <div className="gx-chart" data-testid="chart" data-view="forecast">
      <div ref={box} className="gx-chart-canvas" />
      {geo && (
        <div className="gx-fc-layer" aria-hidden="true">
          <svg width={geo.w} height={geo.h}>
            {geo.bar && (<g stroke={C.muted} strokeWidth="1.5"><line x1={geo.bar.x} x2={geo.bar.x} y1={geo.bar.y1} y2={geo.bar.y2} /><line x1={geo.bar.x - 5} x2={geo.bar.x + 5} y1={geo.bar.y1} y2={geo.bar.y1} /><line x1={geo.bar.x - 5} x2={geo.bar.x + 5} y1={geo.bar.y2} y2={geo.bar.y2} /></g>)}
            {geo.labels.filter((l) => l.leader && l.kind !== "conn").map((l) => (
              <line key={l.id} x1={l.left + (l.x >= l.left + l.w / 2 ? l.w : 0)} y1={l.top + l.h / 2} x2={l.x} y2={l.y} stroke={C.muted} strokeWidth="1" strokeDasharray="2 2" />
            ))}
          </svg>
          {geo.labels.map((l) => (
            <div key={l.id} className={`gx-lbl ${l.kind}`} data-testid={`fc-label-${l.id}`} style={{ left: l.left, top: l.top, width: l.w, height: l.h }}>
              <b className="mono">{l.text}</b>{l.sub && <span>{l.sub}</span>}{l.sub2 && <span>{l.sub2}</span>}
            </div>
          ))}
        </div>
      )}
      {state === "loading" && <div className="gx-chart-msg">Loading chart…</div>}
      {state === "error" && <div className="gx-chart-msg">{errText}</div>}
      {state === "ready" && !forecast && <div className="gx-chart-note">No forecast has been issued for this target yet, so only recent {word} prices are shown.</div>}
    </div>
  );
}

export const FORECAST_FOOT = "The dashed line only connects the forecast reference to the target; it is illustrative and is not a predicted path. The bar at the target is the forecast range.";
export const etTimeLabel = (epoch: number) => `${fmtEt(epoch, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })} ET`;
export { timeLabel };
