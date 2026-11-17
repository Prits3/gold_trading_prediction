import { useEffect, useRef, useState } from "react";
import { AreaSeries, CandlestickSeries, LineType, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time } from "lightweight-charts";
import { api } from "../api";
import type { Bar, Conn, InstrumentKey, OhlcPayload, RangeKey } from "../types";
import { C, INTERVAL_WORDS, STEP, byTime, gapSlots, makeChart, timeLabel } from "../chartKit";
import { num } from "../format";

const POLL_MS = 15000;

/** Price history only: real observations, no forecast drawing of any kind. Live ticks use update(), so zoom and scroll are never reset. */
export function PriceChart({ instrument, range, mode, onMeta, onConn }: {
  instrument: InstrumentKey; range: RangeKey; mode: "line" | "candles"; onMeta?: (m: OhlcPayload) => void; onConn?: (c: Conn) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const area = useRef<ISeriesApi<"Area"> | null>(null);
  const marks = useRef<ISeriesMarkersPluginApi<Time>[]>([]);
  const barMap = useRef<Map<number | string, Bar>>(new Map());
  const meta = useRef<OhlcPayload | null>(null);
  const lastTime = useRef<number | string | null>(null);
  const modeRef = useRef(mode);
  const [tip, setTip] = useState<{ x: number; y: number; rows: string[] } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [errText, setErrText] = useState<string | null>(null);
  modeRef.current = mode;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const chart = makeChart(el);
    candles.current = chart.addSeries(CandlestickSeries, { upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down, priceLineColor: C.accent, lastValueVisible: true, priceLineVisible: true });
    // 2px line, straight segments between real observations (no smoothing), with a very light area fill.
    area.current = chart.addSeries(AreaSeries, { lineColor: C.accent, lineWidth: 2, lineType: LineType.Simple, topColor: "rgba(214,184,120,0.16)", bottomColor: "rgba(214,184,120,0)", priceLineColor: C.accent, lastValueVisible: true, priceLineVisible: true, crosshairMarkerRadius: 4 });
    marks.current = [createSeriesMarkers(candles.current, []), createSeriesMarkers(area.current, [])];
    chart.subscribeCrosshairMove((p) => {
      if (!p.point || !p.time || p.point.x < 0 || p.point.y < 0) return setTip(null);
      const m = meta.current;
      const word = m ? INTERVAL_WORDS[m.interval] ?? m.interval : "";
      const when = typeof p.time === "number" ? `${timeLabel(p.time)}` : timeLabel(p.time);
      const c = p.seriesData.get(candles.current!) as { open?: number; high?: number; low?: number; close?: number } | undefined;
      const l = p.seriesData.get(area.current!) as { value?: number } | undefined;
      if (modeRef.current === "candles" && c && c.open != null) setTip({ x: p.point.x, y: p.point.y, rows: [when, `${word} candle`, `Open ${num(c.open)}  High ${num(c.high!)}`, `Low ${num(c.low!)}  Close ${num(c.close!)}`] });
      else if (modeRef.current === "line" && l && l.value != null) setTip({ x: p.point.x, y: p.point.y, rows: [when, `Price ${num(l.value)}`, `${word} close`] });
      else setTip(null);
    });
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, []);

  const mark = (t: number | string | null) => {
    const m = t == null ? [] : [{ time: t as Time, position: "inBar" as const, shape: "circle" as const, color: C.accent, size: 1 }];
    marks.current.forEach((p) => p.setMarkers(m));
  };

  const loadAll = () => {
    const m = meta.current;
    if (!m || !candles.current || !area.current) return;
    const bars = [...barMap.current.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const gaps = instrument === "spot" && m.time_kind === "epoch" ? gapSlots(bars, STEP[m.interval] ?? 300) : [];
    candles.current.setData(byTime([...bars.map((b) => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })), ...gaps]) as never);
    area.current.setData(byTime([...bars.map((b) => ({ time: b.time as Time, value: b.close })), ...gaps]) as never);
    lastTime.current = bars.length ? bars[bars.length - 1].time : null;
    mark(lastTime.current);
    chartRef.current?.timeScale().fitContent();
  };

  useEffect(() => {
    let dead = false;
    setState("loading"); setErrText(null); barMap.current = new Map(); meta.current = null; lastTime.current = null; setTip(null);
    api.ohlc(instrument, range).then((d) => {
      if (dead) return;
      meta.current = d;
      barMap.current = new Map(d.bars.map((b) => [b.time, b]));
      onMeta?.(d); onConn?.("ok");
      if (!d.bars.length) { setState("empty"); candles.current?.setData([]); area.current?.setData([]); mark(null); return; }
      setState("ready");
      loadAll();
    }).catch((e) => { if (!dead) { setState("error"); setErrText(e instanceof Error ? e.message : "Could not load the chart."); onConn?.("reconnecting"); } });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument, range]);

  // Live updates: update() the newest candle / append new ones. Never setData, never fitContent.
  useEffect(() => {
    const id = window.setInterval(async () => {
      if (document.hidden || !meta.current || !meta.current.bars.length) return;
      const tail = [...barMap.current.values()].slice(-3)[0];
      const since = typeof tail?.time === "number" ? tail.time - 1 : Date.now() / 1000 - 8 * 86400;
      try {
        const d = await api.ohlc(instrument, range, since);
        if (d.instrument !== instrument || d.range !== range || !candles.current || !area.current) return;
        const step = STEP[d.interval] ?? 300;
        for (const b of [...d.bars].sort((x, y) => (x.time < y.time ? -1 : x.time > y.time ? 1 : 0))) {
          const last = lastTime.current;
          if (last != null && b.time < last) continue; // a finalised bar is never rewritten
          const old = barMap.current.get(b.time);
          if (old && old.open === b.open && old.high === b.high && old.low === b.low && old.close === b.close) continue; // de-duplicate repeats
          if (instrument === "spot" && typeof last === "number" && typeof b.time === "number" && b.time - last > step * 1.5) {
            for (let t = last + step; t < b.time; t += step) { candles.current.update({ time: t as Time } as never); area.current.update({ time: t as Time } as never); }
          }
          barMap.current.set(b.time, b);
          candles.current.update({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close });
          area.current.update({ time: b.time as Time, value: b.close });
          lastTime.current = b.time;
        }
        mark(lastTime.current);
        meta.current = { ...meta.current!, delay_seconds: d.delay_seconds };
        onMeta?.(meta.current); onConn?.("ok");
      } catch { onConn?.(navigator.onLine === false ? "offline" : "reconnecting"); }
    }, POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument, range]);

  useEffect(() => { candles.current?.applyOptions({ visible: mode === "candles" }); area.current?.applyOptions({ visible: mode === "line" }); setTip(null); }, [mode]);

  return (
    <div className="gx-chart" data-testid="chart" data-view="history">
      <div ref={box} className="gx-chart-canvas" />
      {tip && <div className="gx-tip mono" style={{ left: Math.min(tip.x + 14, (box.current?.clientWidth ?? 300) - 190), top: Math.max(tip.y - 20, 4) }}>{tip.rows.map((r, i) => <div key={i}>{r}</div>)}</div>}
      {state === "loading" && <div className="gx-chart-msg">Loading chart…</div>}
      {state === "empty" && <div className="gx-chart-msg">{instrument === "spot" ? "No spot ticks recorded for this range yet. Candles appear as the background worker records real prices." : "No data for this range."}</div>}
      {state === "error" && <div className="gx-chart-msg">{errText}</div>}
    </div>
  );
}
