import { useEffect, useRef, useState } from "react";
import { ColorType, CandlestickSeries, CrosshairMode, LineSeries, LineStyle, createChart, createSeriesMarkers, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type Time } from "lightweight-charts";
import { api } from "../api";
import type { Bar, Conn, InstrumentKey, OhlcPayload, RangeKey } from "../types";
import { fmtEt, num } from "../format";

export interface Overlay {
  kind: "today" | "forward";
  originTime: number | string;
  originPrice: number;
  targetTime: number | string;
  predicted: number;
  low: number;
  high: number;
  label: string;
}

const C = { text: "#9AA3AF", grid: "#12161B", up: "#4FA77B", down: "#D2685F", accent: "#D6B878", line: "#E9EDF2", muted: "#6B7480" };
const POLL_MS = 15000;
const STEP: Record<string, number> = { "5m": 300, "30m": 1800, "1h": 3600 };

const etDate = (s: number) => fmtEt(s, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Day-candle times arrive as 'YYYY-MM-DD' strings (or {year,month,day}); returns the parts either way. */
const dayParts = (t: unknown): { y: number; m: number; d: number } => {
  if (typeof t === "string") { const [y, m, d] = t.split("-").map(Number); return { y, m, d }; }
  const o = t as { year: number; month: number; day: number };
  return { y: o.year, m: o.month, d: o.day };
};
const fromBiz = (t: unknown) => { const { y, m, d } = dayParts(t); return `${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y}`; };

/** Pad the series with empty (whitespace) slots so the forecast target sits at its true distance in time, not next to the last candle. */
function futureSlots(last: number | string, target: number | string, kind: "epoch" | "day", interval: string): { time: Time }[] {
  const out: { time: Time }[] = [];
  if (kind === "epoch" && typeof last === "number" && typeof target === "number") {
    const step = STEP[interval] ?? 3600;
    for (let t = last + step, n = 0; t <= target + step && n < 700; t += step, n++) out.push({ time: t as Time });
  } else if (kind === "day" && typeof last === "string" && typeof target === "string") {
    const stepDays = interval === "1wk" ? 7 : 1;
    const end = Date.parse(target + "T00:00:00Z");
    for (let d = Date.parse(last + "T00:00:00Z") + stepDays * 86400000, n = 0; d <= end + stepDays * 86400000 && n < 400; d += stepDays * 86400000, n++) {
      const dt = new Date(d);
      if (stepDays === 1 && (dt.getUTCDay() === 0 || dt.getUTCDay() === 6)) continue;
      out.push({ time: dt.toISOString().slice(0, 10) as Time });
    }
  }
  return out;
}

/** Whitespace for periods where a recorded (spot) series has no ticks, so gaps are shown as gaps. */
function gapSlots(bars: Bar[], step: number): { time: Time }[] {
  const out: { time: Time }[] = [];
  for (let i = 1; i < bars.length && out.length < 600; i++) {
    const a = bars[i - 1].time, b = bars[i].time;
    if (typeof a === "number" && typeof b === "number" && b - a > step * 1.5) for (let t = a + step; t < b && out.length < 600; t += step) out.push({ time: t as Time });
  }
  return out;
}

export function GoldChart({ instrument, range, mode, overlay, onMeta, onConn }: {
  instrument: InstrumentKey; range: RangeKey; mode: "line" | "candles"; overlay: Overlay | null;
  onMeta?: (m: OhlcPayload) => void; onConn?: (c: Conn) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const line = useRef<ISeriesApi<"Line"> | null>(null);
  const connector = useRef<ISeriesApi<"Line"> | null>(null);
  const tPred = useRef<ISeriesApi<"Line"> | null>(null);
  const tLow = useRef<ISeriesApi<"Line"> | null>(null);
  const tHigh = useRef<ISeriesApi<"Line"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const markersMain = useRef<ISeriesMarkersPluginApi<Time>[]>([]);
  const priceLines = useRef<{ s: ISeriesApi<"Candlestick" | "Line">; l: IPriceLine }[]>([]);
  const [compactNote, setCompactNote] = useState<string | null>(null);
  const barMap = useRef<Map<number | string, Bar>>(new Map());
  const meta = useRef<OhlcPayload | null>(null);
  const lastTime = useRef<number | string | null>(null);
  const overlayRef = useRef<Overlay | null>(overlay);
  const modeRef = useRef(mode);
  const [tip, setTip] = useState<{ x: number; y: number; html: string[] } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [note, setNote] = useState<string | null>(null);
  overlayRef.current = overlay;
  modeRef.current = mode;

  // ---- create the chart once ----
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: C.text, fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, attributionLogo: true },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4, minBarSpacing: 2 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: C.muted, style: LineStyle.Dashed, labelBackgroundColor: "#1E242B" }, horzLine: { color: C.muted, style: LineStyle.Dashed, labelBackgroundColor: "#1E242B" } },
      localization: {
        priceFormatter: (p: number) => num(p, 2),
        timeFormatter: (t: unknown) => (typeof t === "number" ? `${etDate(t)} ET` : fromBiz(t)),
      },
      handleScale: { axisPressedMouseMove: true }, handleScroll: { pressedMouseMove: true, horzTouchDrag: true },
    });
    chart.applyOptions({
      timeScale: {
        tickMarkFormatter: (t: unknown, type: number) => {
          if (typeof t !== "number") { const { y, m, d } = dayParts(t); return type === 0 ? String(y) : type === 1 ? MONTHS[m - 1] : `${d} ${MONTHS[m - 1]}`; }
          return type === 3 || type === 4 ? fmtEt(t, { hour: "2-digit", minute: "2-digit", hour12: false }) : fmtEt(t, { day: "numeric", month: "short" });
        },
      },
    });
    candles.current = chart.addSeries(CandlestickSeries, { upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down, priceLineColor: C.accent, lastValueVisible: true, priceLineVisible: true });
    line.current = chart.addSeries(LineSeries, { color: C.line, lineWidth: 2, priceLineColor: C.accent, lastValueVisible: true, priceLineVisible: true, crosshairMarkerRadius: 4 });
    const ov = { color: C.accent, lineStyle: LineStyle.Dashed, lineWidth: 1 as const, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
    connector.current = chart.addSeries(LineSeries, ov);
    const pt = (color: string) => chart.addSeries(LineSeries, { color, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 4, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    tPred.current = pt(C.accent);
    tLow.current = pt(C.muted);
    tHigh.current = pt(C.muted);
    markers.current = createSeriesMarkers(connector.current, []);
    markersMain.current = [createSeriesMarkers(candles.current, []), createSeriesMarkers(line.current, [])];
    chart.subscribeCrosshairMove((p) => {
      if (!p.point || !p.time || p.point.x < 0 || p.point.y < 0) return setTip(null);
      const c = p.seriesData.get(candles.current!) as { open?: number; high?: number; low?: number; close?: number } | undefined;
      const l = p.seriesData.get(line.current!) as { value?: number } | undefined;
      const when = typeof p.time === "number" ? `${etDate(p.time)} ET` : fromBiz(p.time);
      const rows = [when];
      if (modeRef.current === "candles" && c && c.open != null) rows.push(`O ${num(c.open!)}  H ${num(c.high!)}`, `L ${num(c.low!)}  C ${num(c.close!)}`);
      else if (l && l.value != null) rows.push(`Price ${num(l.value)}`);
      else return setTip(null);
      setTip({ x: p.point.x, y: p.point.y, html: rows });
    });
    chartRef.current = chart;
    (window as unknown as { __gxChart?: IChartApi }).__gxChart = chart; // handle for the browser checks (zoom must survive live updates)
    return () => { chart.remove(); chartRef.current = null; };
  }, []);

  // ---- full (re)load: only on instrument/range change. Live ticks never go through here, so the user's zoom is never reset. ----
  const loadAll = () => {
    const m = meta.current;
    if (!m || !candles.current || !line.current) return;
    const bars = [...barMap.current.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const gaps = instrument === "spot" && m.time_kind === "epoch" ? gapSlots(bars, STEP[m.interval] ?? 300) : [];
    const sortT = <T extends { time: Time }>(a: T[]) => a.sort((x, y) => (x.time < y.time ? -1 : x.time > y.time ? 1 : 0));
    candles.current.setData(sortT([...bars.map((b) => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })), ...gaps]) as never);
    line.current.setData(sortT([...bars.map((b) => ({ time: b.time as Time, value: b.close })), ...gaps]) as never);
    lastTime.current = bars.length ? bars[bars.length - 1].time : null;
    paintOverlay();
    chartRef.current?.timeScale().fitContent();
  };

  // ---- forecast overlay (futures only): origin marker, dashed endpoint connector, target point and range. No invented path.
  //      The empty future slots live in the overlay's own series, so the price series can keep using cheap update() calls. ----
  const clearOverlay = () => {
    for (const sr of [connector, tPred, tLow, tHigh]) sr.current?.setData([]);
    markers.current?.setMarkers([]);
    markersMain.current.forEach((p) => p.setMarkers([]));
    priceLines.current.forEach(({ s, l }) => { try { s.removePriceLine(l); } catch { /* series already gone */ } });
    priceLines.current = [];
  };
  const paintOverlay = () => {
    const m = meta.current, ov = overlayRef.current;
    const usable = m && ov && ((m.time_kind === "epoch") === (ov.kind === "today")) ? ov : null;
    clearOverlay();
    setCompactNote(null);
    if (!usable || lastTime.current == null) return;
    const slots = futureSlots(lastTime.current, usable.targetTime, m!.time_kind, m!.interval).filter((x) => x.time > usable.originTime && x.time < usable.targetTime);
    const originMarker = [{ time: lastTime.current as Time, position: "inBar" as const, shape: "circle" as const, color: C.accent, text: "Forecast origin", size: 1 }];
    if (slots.length > Math.max(20, 0.6 * barMap.current.size)) {
      // The target is too far ahead to draw at true time scale without squashing the candles: show it as labelled price levels instead.
      const mk = (price: number, title: string, color: string, style: LineStyle) => [candles.current!, line.current!].forEach((sr) => {
        priceLines.current.push({ s: sr, l: sr.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }) });
      });
      mk(usable.predicted, "Target", C.accent, LineStyle.Dashed);
      mk(usable.high, "80% high", C.muted, LineStyle.Dotted);
      mk(usable.low, "80% low", C.muted, LineStyle.Dotted);
      markersMain.current.forEach((p) => p.setMarkers(originMarker));
      setCompactNote(`Target ${fmtEt(Math.round(Date.parse(String(usable.targetTime)) / 1000 || Number(usable.targetTime)), { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })} ET is too far ahead to draw to scale — shown as price levels.`);
      return;
    }
    connector.current!.setData([{ time: usable.originTime as Time, value: usable.originPrice }, ...slots, { time: usable.targetTime as Time, value: usable.predicted }] as never);
    tPred.current!.setData([{ time: usable.targetTime as Time, value: usable.predicted }]);
    tLow.current!.setData([{ time: usable.targetTime as Time, value: usable.low }]);
    tHigh.current!.setData([{ time: usable.targetTime as Time, value: usable.high }]);
    markers.current?.setMarkers([{ time: usable.originTime as Time, position: "inBar", shape: "circle", color: C.accent, text: "Forecast origin", size: 1 }]);
  };

  // ---- load on instrument / range change ----
  useEffect(() => {
    let dead = false;
    setState("loading"); setNote(null); barMap.current = new Map(); meta.current = null; lastTime.current = null;
    api.ohlc(instrument, range).then((d) => {
      if (dead) return;
      meta.current = d;
      barMap.current = new Map(d.bars.map((b) => [b.time, b]));
      onMeta?.(d);
      onConn?.("ok");
      if (!d.bars.length) { setState("empty"); candles.current?.setData([]); line.current?.setData([]); paintOverlay(); return; }
      setState("ready");
      loadAll();
    }).catch((e) => { if (!dead) { setState("error"); setNote(e instanceof Error ? e.message : "Could not load the chart."); onConn?.("reconnecting"); } });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument, range]);

  // ---- live updates: update() the last candle / append new ones. Never setData, never fitContent: zoom and scroll stay put. ----
  useEffect(() => {
    const id = window.setInterval(async () => {
      if (document.hidden || !meta.current || !meta.current.bars.length) return;
      const tail = [...barMap.current.values()].slice(-3)[0];
      const since = typeof tail?.time === "number" ? tail.time - 1 : Date.now() / 1000 - 8 * 86400;
      try {
        const d = await api.ohlc(instrument, range, since);
        if (d.instrument !== instrument || d.range !== range || !candles.current || !line.current) return;
        const step = STEP[d.interval] ?? 300;
        for (const b of [...d.bars].sort((x, y) => (x.time < y.time ? -1 : x.time > y.time ? 1 : 0))) {
          const last = lastTime.current;
          if (last != null && b.time < last) continue; // a bar already finalised earlier: never rewrite history
          const old = barMap.current.get(b.time);
          if (old && old.open === b.open && old.high === b.high && old.low === b.low && old.close === b.close) continue; // de-duplicate repeats
          if (instrument === "spot" && typeof last === "number" && typeof b.time === "number" && b.time - last > step * 1.5) {
            for (let t = last + step; t < b.time; t += step) { candles.current.update({ time: t as Time } as never); line.current.update({ time: t as Time } as never); }
          }
          barMap.current.set(b.time, b);
          candles.current.update({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close });
          line.current.update({ time: b.time as Time, value: b.close });
          lastTime.current = b.time;
        }
        meta.current = { ...meta.current!, delay_seconds: d.delay_seconds };
        onMeta?.(meta.current);
        onConn?.("ok");
      } catch { onConn?.(navigator.onLine === false ? "offline" : "reconnecting"); }
    }, POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument, range]);

  // ---- series type switch and overlay changes (no data refetch, no zoom reset) ----
  useEffect(() => { candles.current?.applyOptions({ visible: mode === "candles" }); line.current?.applyOptions({ visible: mode === "line" }); }, [mode]);
  useEffect(() => { if (state === "ready") paintOverlay(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [overlay?.kind, overlay?.targetTime, overlay?.predicted, overlay?.low, overlay?.high, overlay?.originPrice, state]);

  return (
    <div className="gx-chart" data-testid="chart">
      <div ref={box} className="gx-chart-canvas" />
      {tip && <div className="gx-tip mono" style={{ left: Math.min(tip.x + 14, (box.current?.clientWidth ?? 300) - 170), top: Math.max(tip.y - 20, 4) }}>{tip.html.map((r, i) => <div key={i}>{r}</div>)}</div>}
      {state === "loading" && <div className="gx-chart-msg">Loading chart…</div>}
      {state === "empty" && <div className="gx-chart-msg">{instrument === "spot" ? "No spot ticks recorded for this range yet. Candles appear as the background worker records real prices." : "No data for this range."}</div>}
      {state === "error" && <div className="gx-chart-msg">{note}</div>}
      {compactNote && <div className="gx-chart-note">{compactNote}</div>}
    </div>
  );
}
