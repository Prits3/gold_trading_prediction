// Browser verification. Usage: URL=http://127.0.0.1:8750 OUT=/path node e2e/verify.mjs
import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.URL || "http://127.0.0.1:8750";
const OUT = process.env.OUT || "e2e/screenshots";
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const num = (s) => parseFloat(String(s).replace(/[^0-9.\-−]/g, "").replace("−", "-"));
const api = async (p) => (await fetch(`${URL}/api${p}`)).json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(viewport, { routes } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [], bad = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) bad.push(`${r.status()} ${r.url().replace(URL, "")}`); });
  if (routes) await routes(page);
  await page.goto(URL);
  await page.waitForSelector('[data-testid="price"]', { timeout: 40000 });
  await page.waitForSelector('[data-testid="today-card"]', { timeout: 40000 });
  await page.waitForTimeout(3000);
  return { ctx, page, errors, bad };
}
const txt = async (page, id) => (await page.textContent(`[data-testid="${id}"]`)).trim();

/** All forecast-view labels: none may overlap another, none may be clipped by the chart. */
async function labelAudit(page) {
  await page.locator('[data-testid="chart"]').scrollIntoViewIfNeeded(); await page.waitForTimeout(400);  // elementFromPoint only sees what is on screen
  return page.evaluate(() => {
    const chart = document.querySelector('[data-testid="chart"]').getBoundingClientRect();
    const labels = [...document.querySelectorAll('[data-testid^="fc-label-"]')].map((e) => ({ id: e.dataset.testid, r: e.getBoundingClientRect() }));
    const overlaps = [];
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i].r, b = labels[j].r;
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push(`${labels[i].id}×${labels[j].id}`);
    }
    const axisW = window.__gxChart.priceScale("right").width();
    const overAxis = labels.filter((l) => l.r.right > chart.right - axisW + 0.5).map((l) => l.id);
    const layer = document.querySelector(".gx-fc-layer"); const prev = layer ? layer.style.pointerEvents : "";
    if (layer) { layer.style.pointerEvents = "auto"; layer.querySelectorAll(".gx-lbl").forEach((n) => (n.style.pointerEvents = "auto")); }  // elementFromPoint ignores pointer-events:none
    const covered = labels.filter((l) => { const el = document.elementFromPoint(l.r.left + l.r.width / 2, l.r.top + l.r.height / 2); return !(el && el.closest('[data-testid^="fc-label-"]')); }).map((l) => l.id);
    if (layer) { layer.style.pointerEvents = prev; layer.querySelectorAll(".gx-lbl").forEach((n) => (n.style.pointerEvents = "")); }
    const clipped = labels.filter((l) => l.r.left < chart.left - 0.5 || l.r.right > chart.right + 0.5 || l.r.top < chart.top - 0.5 || l.r.bottom > chart.bottom + 0.5).map((l) => l.id);
    const fl = document.querySelector('[data-testid="fc-label-forecast"]');
    return { forecastText: fl ? fl.textContent : "", n: labels.length, overlaps, clipped, overAxis, covered, ids: labels.map((l) => l.id.replace("fc-label-", "")) };
  });
}
const patchJson = (page, glob, patch) => page.route(glob, async (route) => { const r = await route.fetch(); const j = await r.json(); await route.fulfill({ response: r, json: patch(j) }); });

// ============================== desktop: the real, unmodified app ==============================
{
  const { ctx, page, errors, bad } = await open({ width: 1440, height: 1000 });
  check("price summary: price, signed change, USD per troy oz", num(await txt(page, "price")) > 500 && /[▲▼■]/.test(await txt(page, "change")) && /per troy oz/.test(await page.textContent(".gx-cur")), `${await txt(page, "price")} | ${await txt(page, "change")}`);
  check("delayed-feed status is visible next to the chart", /Delayed|Live|Market closed|Stale/.test(await txt(page, "feed-status")), await txt(page, "feed-status"));
  const order = await page.evaluate(() => ["price", "forecast-section", "chart"].map((id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().top));
  check("the two forecast cards sit ABOVE the chart", order[0] < order[1] && order[1] < order[2], order.map(Math.round).join(" < "));
  check("default chart view is Price history", (await page.getAttribute('[data-testid="view-history"]', "aria-selected")) === "true");
  check("history view draws no forecast labels, target lines or 'too far ahead' banner", (await page.locator('[data-testid^="fc-label-"]').count()) === 0 && !/too far ahead/.test(await page.textContent('[data-testid="chart"]')));
  await page.screenshot({ path: `${OUT}/desktop-history-candles.png`, fullPage: true });

  const ohlc = await api("/market/ohlc?instrument=futures&range=1D");
  check("futures 1D is real OHLC (high >= open/close >= low on every bar)", ohlc.real_ohlc && ohlc.bars.length > 20 && ohlc.bars.every((b) => b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)), `${ohlc.bars.length} bars, ${ohlc.interval}`);
  await page.locator('[data-testid="chart"]').scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
  const box = await page.locator('[data-testid="chart"] .gx-chart-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5); await page.waitForTimeout(500);
  const tipC = await page.locator(".gx-tip").allTextContents();
  check("candles: hover shows time, open, high, low, close and the interval", tipC.length && /Open/.test(tipC[0]) && /High/.test(tipC[0]) && /Low/.test(tipC[0]) && /Close/.test(tipC[0]) && /5-minute candle/.test(tipC[0]) && /ET/.test(tipC[0]), (tipC[0] || "").replace(/\n/g, " | "));
  check("candles: interval is stated under the chart", /5[ -]minutes?/.test(await txt(page, "chart-foot")), await txt(page, "chart-foot"));
  await page.click('[data-testid="mode-line"]'); await page.waitForTimeout(600);
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5); await page.waitForTimeout(500);
  const tipL = await page.locator(".gx-tip").allTextContents();
  check("line: hover shows observation time and price", tipL.length && /ET/.test(tipL[0]) && /Price [\d,]+\.\d\d/.test(tipL[0]), (tipL[0] || "").replace(/\n/g, " | "));
  check("line: 'Each point is a 5-minute close' is stated", /Each point is a 5-minute close/.test(await txt(page, "chart-foot")));
  await page.screenshot({ path: `${OUT}/desktop-history-line.png`, fullPage: true });
  await page.click('[data-testid="mode-candles"]');

  await page.click('[data-testid="chart-info"]');
  check("provider and session explanations are behind the information button", /Source:/.test(await txt(page, "chart-info-panel")) && /Session:/.test(await txt(page, "chart-info-panel")));
  await page.click('[data-testid="chart-info"]');

  for (const r of ["1W", "1M", "3M", "1Y", "5Y", "1D"]) {
    await page.click(`[data-testid="range-${r}"]`); await page.waitForTimeout(1500);
    const d = await api(`/market/ohlc?instrument=futures&range=${r}`);
    check(`range ${r}: real ${d.interval} candles`, d.bars.length > 20 && (await page.getAttribute(`[data-testid="range-${r}"]`, "aria-selected")) === "true", `${d.bars.length} bars`);
  }

  // ---- forecast cards: frozen values, sentence, source label, range wording ----
  const tj = await api("/forecast/today");
  const card = await page.textContent('[data-testid="today-card"]');
  const tgt0 = await txt(page, "today-target");
  check("next-settlement card: price, target weekday/date, New York and Berlin time, reference, prediction range, issued", /\$[\d,]+\.\d\d/.test(await txt(page, "today-pred")) && /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}( \d{4})? · \d\d:\d\d New York · \d\d:\d\d Berlin/.test(tgt0) && /Reference \$[\d,]+\.\d\d/.test(card) && /Prediction range: \$[\d,]+\.\d\d–\$[\d,]+\.\d\d/.test(card) && /Issued .*New York/.test(card), tgt0);
  check("timezone labels are not duplicated (each zone named once in the target line; no 'ET' abbreviations on the cards)", (tgt0.match(/New York/g) || []).length === 1 && (tgt0.match(/Berlin/g) || []).length === 1 && !/\bET\b/.test(card + await page.textContent('[data-testid="forward-card"]')), tgt0);
  check("the card shows no model id or version name (those live in Model details)", !/nowcast:|fwd_\d|price_now_v1|gold_v1|ridge|random forest/i.test(card + await page.textContent('[data-testid="forward-card"]')));
  check("the reference price sits beside the change and says what it is", /Reference \$[\d,]+\.\d\d · the latest futures price when issued/.test(await txt(page, "today-ref")) && /change [+−]\$[\d.,]+/.test(await txt(page, "today-ref")), await txt(page, "today-ref"));
  check("audit: a copied current price is labelled 'Unchanged-price baseline', not presented as a learned prediction", tj.forecast.source.kind === "baseline" ? /Unchanged-price baseline/.test(await txt(page, "source-chip")) && /No model is in control/.test(await txt(page, "today-sentence")) : true, `${tj.forecast.source.label} (${tj.forecast.source.version})`);
  check("near-identical prediction says 'Little change predicted'", tj.forecast.little_change ? /Little change predicted/.test(await txt(page, "today-vs")) : !/Little change predicted/.test(await txt(page, "today-vs")), `change ${tj.forecast.change_pct}%`);
  check("the live quote comparison is separately labelled", /Latest futures quote/.test(await page.textContent('[data-testid="today-card"]')) || tj.status === "completed");
  await wait(21000);
  const t2 = await api("/forecast/today");
  check("forecast values do not change when quotes update (the reference is frozen)", t2.forecast.forecast_id !== tj.forecast.forecast_id || (t2.forecast.predicted === tj.forecast.predicted && t2.forecast.reference_price === tj.forecast.reference_price), `${tj.forecast.forecast_id.slice(-30)} ${tj.forecast.predicted} / ${t2.forecast.predicted}`);

  const seen = {};
  for (const h of [1, 5, 20]) {
    await page.click(`[data-testid="h-${h}"]`);
    await page.waitForFunction(() => !/Loading forecast/.test(document.querySelector('[data-testid="forward-card"]')?.textContent || ""), null, { timeout: 60000 });
    await page.waitForTimeout(400);
    const none = await page.locator('[data-testid="fwd-none"]').count();
    seen[h] = none ? { none: true, why: (await txt(page, "fwd-none")) } : { p: num(await txt(page, "fwd-pred")), cal: (await page.textContent('[data-testid="forward-card"] [data-testid="calibration"]')).trim(), lbl: await page.locator('[data-testid="forward-card"] [data-testid="calibration-label"]').count(), target: (await page.textContent('[data-testid="forward-card"] [data-testid="fwd-target"]')).trim(), ref: await txt(page, "fwd-ref"), chg: await txt(page, "fwd-change") };
    await page.screenshot({ path: `${OUT}/desktop-forward-${h}.png`, clip: { x: 0, y: 250, width: 1440, height: 560 } });
  }
  check("all horizons: 5 and 20 have distinct future targets; 1 session is valid OR explained", seen[5].p > 500 && seen[20].p > 500 && seen[5].target !== seen[20].target && (seen[1].none ? /settlement|session|provider/.test(seen[1].why) : seen[1].p > 500), JSON.stringify({ 1: seen[1].none ? "explained" : seen[1].target, 5: seen[5].target, 20: seen[20].target }));
  check("1-session: any wait is explained as a genuine provider/session delay, not a bare 'pending'", seen[1].none ? seen[1].why.length > 60 : true, (seen[1].why || "").slice(0, 110));
  const learn = await api("/learning");
  check("20-session: '80% target range · historical coverage X%' with 'Under-calibrated' when materially below", /80% target range · historical coverage \d+%/.test(seen[20].cal) && (learn.tasks.fwd_20.calibration.historical_pct < 72 ? seen[20].lbl === 1 && /Under-calibrated/.test(seen[20].cal) : seen[20].lbl === 0), seen[20].cal.replace(/\s+/g, " ").slice(0, 125));
  check("5-session: range wording present and not labelled under-calibrated when close to 80%", /80% range · historical coverage \d+%/.test(seen[5].cal) && seen[5].lbl === 0, seen[5].cal.replace(/\s+/g, " ").slice(0, 100));
  check("each forward card gives its prediction range with the reference price beside the change", /Prediction range: \$[\d,]+\.\d\d–\$[\d,]+\.\d\d/.test(seen[20].cal) && /Reference \$[\d,]+\.\d\d · official settlement of .*\d{4}/.test(seen[20].ref) && /versus the forecast's base close/.test(seen[20].chg), seen[20].ref + " | " + seen[20].chg);
  await page.click('[data-testid="h-5"]'); await page.waitForTimeout(1500);

  // ---- forecast view ----
  await page.click('[data-testid="range-1M"]'); await page.waitForTimeout(1200);
  await page.click('[data-testid="view-forecast"]'); await page.waitForTimeout(2500);
  check("Forecast view offers an explicit Next settlement / 1 / 5 / 20 selector", (await page.locator('[data-testid^="target-"]').count()) === 4);
  const audits = {};
  for (const t of ["next", "5", "20", "1"]) {
    await page.click(`[data-testid="target-${t}"]`); await page.waitForTimeout(3500);
    audits[t] = await labelAudit(page);
    await page.screenshot({ path: `${OUT}/desktop-forecast-${t}.png`, fullPage: true });
  }
  for (const t of ["next", "5", "20"]) {
    const a = audits[t];
    check(`forecast view (${t}): latest, reference, forecast, range and 'Illustrative connection' labels are shown`, ["latest", "ref", "forecast", "high", "low", "conn"].every((k) => a.ids.includes(k)), a.ids.join(","));
    check(`forecast view (${t}): labels never overlap, are never clipped, never sit under the chart or over the price axis`, a.overlaps.length === 0 && a.clipped.length === 0 && a.covered.length === 0 && a.overAxis.length === 0, `overlaps ${a.overlaps.join(",") || "none"} clipped ${a.clipped.join(",") || "none"} covered ${a.covered.join(",") || "none"} overAxis ${a.overAxis.join(",") || "none"}`);
    check(`forecast view (${t}): the target's date and time are written on its price label`, /\d{1,2} \w{3} · \d\d:\d\d New York/.test(a.forecastText), a.forecastText.trim().slice(0, 70));
  }
  check("forecast view (1 session, none issued): no fake target is drawn", audits["1"].n === 0 || audits["1"].ids.includes("forecast"), audits["1"].ids.join(",") || "no labels");
  await page.click('[data-testid="target-5"]'); await page.waitForTimeout(2500);
  const before = await page.locator('[data-testid="fc-label-forecast"]').textContent();
  await page.click('[data-testid="mode-line"]'); await page.waitForTimeout(800);
  const after = await page.locator('[data-testid="fc-label-forecast"]').textContent();
  check("switching Candles/Line does not alter the forecast", before === after, before);
  await page.click('[data-testid="mode-candles"]');
  await page.click('[data-testid="view-history"]'); await page.waitForTimeout(1500);
  check("returning to Price history keeps the selected range (1M) and removes all forecast drawing", (await page.getAttribute('[data-testid="range-1M"]', "aria-selected")) === "true" && (await page.locator('[data-testid^="fc-label-"]').count()) === 0);
  await page.click('[data-testid="range-1D"]'); await page.waitForTimeout(1500);

  // ---- selecting a forecast card drives the Forecast chart ----
  const sel = async (id) => page.getAttribute(`[data-testid="${id}"]`, "data-selected");
  check("in Price history neither card is highlighted", (await sel("today-card")) === "false" && (await sel("forward-card")) === "false");
  const matches = async (cardId, predId) => {
    const pred = await txt(page, predId);
    const a = await labelAudit(page);
    const f = await page.locator('[data-testid="fc-label-forecast"]').textContent();
    const hi = await page.locator('[data-testid="fc-label-high"]').textContent();
    const lo = await page.locator('[data-testid="fc-label-low"]').textContent();
    const ref = await page.locator('[data-testid="fc-label-ref"]').textContent();
    const cardTxt = await page.textContent(`[data-testid="${cardId}"]`);
    const rng = cardTxt.match(/Prediction range: \$([\d,]+\.\d\d)–\$([\d,]+\.\d\d)/);
    const refC = cardTxt.match(/Reference \$([\d,]+\.\d\d)/);
    return { ok: f.includes(pred.replace("$", "")) && !!rng && hi.includes(rng[2]) && lo.includes(rng[1]) && !!refC && ref.includes(refC[1]) && a.overlaps.length === 0 && a.clipped.length === 0, detail: `${pred} ${rng?.[1]}–${rng?.[2]} ref ${refC?.[1]} | ${f.replace(/\s+/g, " ").slice(0, 60)}` };
  };
  await page.click('[data-testid="forward-card"] .gx-big'); await page.waitForTimeout(3500);
  check("clicking the forward card opens the Forecast view with that card highlighted", (await page.getAttribute('[data-testid="view-forecast"]', "aria-selected")) === "true" && (await sel("forward-card")) === "true" && (await sel("today-card")) === "false");
  let m = await matches("forward-card", "fwd-pred");
  check("forward card selected: chart target, reference and range equal the card exactly", m.ok, m.detail);
  await page.click('[data-testid="today-card"] .gx-big'); await page.waitForTimeout(3500);
  check("clicking Next settlement highlights it and moves the selector to Next settlement", (await sel("today-card")) === "true" && (await sel("forward-card")) === "false" && (await page.getAttribute('[data-testid="target-next"]', "aria-selected")) === "true");
  m = await matches("today-card", "today-pred");
  check("next settlement selected: chart target, reference and range equal the card exactly", m.ok, m.detail);
  await page.click('[data-testid="forward-card"] [data-testid="h-20"]'); await page.waitForTimeout(3500);
  m = await matches("forward-card", "fwd-pred");
  check("changing the card's horizon in Forecast view re-targets the chart (20 sessions)", (await sel("forward-card")) === "true" && (await page.getAttribute('[data-testid="target-20"]', "aria-selected")) === "true" && m.ok, m.detail);
  await page.click('[data-testid="target-5"]'); await page.waitForTimeout(3000);
  check("choosing 5 sessions on the chart selector updates the forward card to 5 sessions", /^5-SESSION/.test(await page.textContent('[data-testid="forward-card"] h2')) && (await sel("forward-card")) === "true");
  await page.click('[data-testid="view-history"]'); await page.waitForTimeout(1200);
  check("back in Price history the cards are unselected and the range is kept", (await sel("forward-card")) === "false" && (await page.getAttribute('[data-testid="range-1D"]', "aria-selected")) === "true");

  const orig = await page.evaluate(() => { const c = window.__gxChart; const r = c.timeScale().getVisibleLogicalRange(); c.timeScale().setVisibleLogicalRange({ from: r.from + 30, to: r.to - 10 }); return r; });
  await page.waitForTimeout(500);
  const z0 = await page.evaluate(() => window.__gxChart.timeScale().getVisibleLogicalRange());
  check("test setup: zoom applied", Math.abs(z0.from - (orig.from + 30)) < 1.5);
  await page.waitForTimeout(40000);
  const z1 = await page.evaluate(() => window.__gxChart.timeScale().getVisibleLogicalRange());
  check("zoom/scroll preserved across live quote updates", Math.abs(z1.from - z0.from) < 1 && Math.abs(z1.to - z0.to) < 1, `${z0.from.toFixed(1)}..${z0.to.toFixed(1)} -> ${z1.from.toFixed(1)}..${z1.to.toFixed(1)}`);

  await page.click('[data-testid="inst-spot"]'); await page.waitForTimeout(3500);
  const sp = await api("/market/summary?instrument=spot");
  const spotChart = await api("/market/ohlc?instrument=spot&range=1D");
  check("spot selected: summary and chart are spot (not futures)", /Spot/.test(sp.name) && spotChart.instrument === "spot" && /gold-api/.test(spotChart.source), `${sp.name} ${sp.price}`);
  check("the futures/spot distinction is explained exactly once", (await page.locator('[data-testid="futures-note"]').count()) === 1 && !/not claimed for spot|not evaluated for spot/.test((await page.textContent('[data-testid="today-card"]')) + (await page.textContent('[data-testid="forward-card"]'))));
  check("forecast cards stay clearly labelled as futures while Spot is selected", (await page.locator(".gx-card .gx-chip", { hasText: "Futures" }).count()) === 2 && /Gold futures forecasts/.test(await page.textContent('[data-testid="forecast-section"]')));
  check("forecast view is unavailable on spot (futures forecasts are not drawn on a spot chart)", await page.isDisabled('[data-testid="view-forecast"]'));
  const prevTxt = await page.textContent(".gx-stats");
  check("spot previous close: a recorded value or 'Unavailable from provider', never a futures substitute", sp.previous_close == null ? /Unavailable from provider/.test(prevTxt) && sp.previous_close_status === "unavailable_from_provider" : sp.previous_close_status === "recorded" && Math.abs(sp.previous_close - sp.price) < 100, `${sp.previous_close_status}`);
  await page.screenshot({ path: `${OUT}/desktop-spot.png`, fullPage: true });
  await page.click('[data-testid="inst-futures"]'); await page.waitForTimeout(2000);
  check("switching back to futures restores the futures summary", /GC=F/.test(await page.textContent(".gx-micro")));

  await page.click('[data-testid="open-details"]'); await page.waitForSelector('[data-testid="model-tab"]', { timeout: 20000 });
  check("Model details: calibration audit shows coverage and width per horizon", (await page.locator('[data-testid="calibration-audit"] tbody tr').count()) === 3 && /Under-calibrated/.test(await txt(page, "calibration-audit")));
  await page.screenshot({ path: `${OUT}/desktop-drawer-calibration.png` });
  await page.keyboard.press("Escape");
  check("no console errors or failed API calls on the real app", errors.length === 0 && bad.length === 0, [...errors, ...bad].slice(0, 4).join(" | "));
  await ctx.close();
}

// ============================== edge cases through modified real payloads ==============================
{
  const { ctx, page, errors } = await open({ width: 1440, height: 1000 }, {
    routes: async (page) => {
      await patchJson(page, "**/api/forecast/forward*", (j) => j.status === "none" ? j : { ...j, status: "completed", forecast: { ...j.forecast, target_time: "2026-11-10T13:30:00-05:00", target_date: "2026-11-10", input_cutoff: Date.parse("2026-11-05T18:30:00Z") / 1000, issued_at: Date.parse("2026-11-05T23:30:00Z") / 1000 }, result: { matured: true, actual: j.forecast.predicted - 40, abs_error: 40, in_range: true },
        next_forecast: { state: "waiting_for_provider", message: "The session has ended, but Yahoo's free daily series has not posted its official settlement yet. The next forecast is issued as soon as it does." } });
      await patchJson(page, "**/api/forecast/today", (j) => ({ ...j, status: "current", forecast: { ...j.forecast, predicted: j.forecast.reference_price * 1.031, low: j.forecast.reference_price * 1.0, high: j.forecast.reference_price * 1.06, change: j.forecast.reference_price * 0.031, change_pct: 3.1, little_change: false, source: { ...j.forecast.source, kind: "model", label: "Ridge model", algorithm: "ridge" } } }));
    },
  });
  await page.click('[data-testid="h-5"]'); await page.waitForTimeout(2500);
  check("a forecast whose target has passed is shown as COMPLETED with actual and error, not as current", /Completed/.test(await txt(page, "completed-banner")) && /Actual/.test(await txt(page, "completed-banner")) && (await page.getAttribute('[data-testid="forward-card"]', "data-status")) === "completed");
  check("a genuine provider delay is explained beside a completed forecast", /official settlement/.test(await txt(page, "next-forecast")));
  check("a large predicted move shows the signed change, not 'Little change'", !/Little change/.test(await txt(page, "today-vs")) && /[▲▼]/.test(await txt(page, "today-vs")), await txt(page, "today-vs"));
  await page.click('[data-testid="view-forecast"]'); await page.waitForTimeout(3500);
  const a = await labelAudit(page);
  check("large prediction-vs-price gap: labels separate and stay inside the chart", a.n >= 6 && a.overlaps.length === 0 && a.clipped.length === 0, `${a.ids.join(",")} overlaps ${a.overlaps.join(",") || "none"}`);
  await page.screenshot({ path: `${OUT}/desktop-forecast-large-gap.png`, fullPage: true });
  await page.click('[data-testid="target-5"]'); await page.waitForTimeout(3500);
  const a5 = await labelAudit(page);
  check("completed target on the chart: the target and the actual are both labelled with no overlap", a5.ids.includes("actual") && a5.overlaps.length === 0 && a5.clipped.length === 0, a5.ids.join(","));
  await page.screenshot({ path: `${OUT}/desktop-forecast-completed.png`, fullPage: true });
  check("no console errors with edited payloads", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
{
  const { ctx, page, errors } = await open({ width: 1440, height: 1000 }, {
    routes: async (page) => {
      await patchJson(page, "**/api/market/summary*", (j) => ({ ...j, status: { state: "stale", label: "Stale: no recent trades" }, delay_seconds: 5400 }));
      await page.route("**/api/forecast/today", (route) => route.fulfill({ json: { status: "none", message: "No settlement forecast has been issued yet. One is issued each hour while the market is open." } }));
    },
  });
  check("a stale quote is labelled Stale, not Live", /Stale/.test(await txt(page, "conn-status")) && /Stale/.test(await txt(page, "feed-status")) && !/Live/.test(await txt(page, "feed-status")), await txt(page, "feed-status"));
  check("a missing next-settlement forecast says so instead of showing a number", /No settlement forecast has been issued yet/.test(await page.textContent('[data-testid="today-card"]')));
  await page.click('[data-testid="view-forecast"]'); await page.waitForTimeout(2500);
  check("forecast view with no forecast: no labels are drawn and an explanation is shown", (await page.locator('[data-testid^="fc-label-"]').count()) === 0 && /No forecast has been issued/.test(await page.textContent('[data-testid="chart"]')));
  check("no console errors with a missing forecast", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

// ============================== outage and recovery ==============================
{
  const { ctx, page } = await open({ width: 1440, height: 900 });
  const keep = num(await txt(page, "price"));
  await page.route("**/api/market/**", (r) => r.abort());
  await page.waitForFunction(() => /Reconnecting|Offline/.test(document.querySelector('[data-testid="conn-status"]')?.textContent || ""), null, { timeout: 40000 });
  check("outage shows 'Reconnecting…' and keeps the last good price", num(await txt(page, "price")) === keep, await txt(page, "conn-status"));
  await page.unroute("**/api/market/**");
  await page.waitForFunction(() => /Live|Delayed|closed/i.test(document.querySelector('[data-testid="conn-status"]')?.textContent || ""), null, { timeout: 40000 });
  check("status recovers automatically", true, await txt(page, "conn-status"));
  await ctx.close();
}

// ============================== mobile 390 ==============================
{
  const { ctx, page, errors, bad } = await open({ width: 390, height: 844 });
  const sw = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  check("390px: no page-level horizontal scroll", sw.s <= sw.c + 1, `${sw.s} vs ${sw.c}`);
  const order = await page.evaluate(() => ["price", "forecast-section", "chart"].map((id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().top));
  check("390px: price → forecast cards → chart", order[0] < order[1] && order[1] < order[2], order.map(Math.round).join(" < "));
  const small = await page.evaluate(() => [...document.querySelectorAll(".gx button")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height < 28; }).map((b) => b.textContent.trim().slice(0, 12)));
  check("390px: touch targets are comfortable", small.length === 0, small.join(","));
  const nB = (await api("/market/ohlc?instrument=futures&range=1D")).bars.length;
  await page.locator('[data-testid="chart"]').scrollIntoViewIfNeeded();
  const vis = await page.evaluate(() => window.__gxChart.timeScale().getVisibleLogicalRange());
  check("390px: the history chart shows the latest candles", vis.to >= nB - 1 && (vis.to - vis.from) >= nB * 0.5, `visible ${vis.from.toFixed(0)}..${vis.to.toFixed(0)} of ${nB}`);
  await page.screenshot({ path: `${OUT}/mobile-history.png` });
  await page.screenshot({ path: `${OUT}/mobile-full.png`, fullPage: true });
  await page.click('[data-testid="view-forecast"]'); await page.waitForTimeout(3000);
  for (const t of ["next", "5", "20"]) {
    await page.click(`[data-testid="target-${t}"]`); await page.waitForTimeout(3500);
    const a = await labelAudit(page);
    check(`390px forecast view (${t}): labels do not overlap, are not clipped, not under the chart and not over the axis`, a.n >= 5 && a.overlaps.length === 0 && a.clipped.length === 0 && a.covered.length === 0 && a.overAxis.length === 0, `${a.ids.join(",")} overlaps ${a.overlaps.join(",") || "none"} clipped ${a.clipped.join(",") || "none"}`);
    await page.locator('[data-testid="chart"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/mobile-forecast-${t}.png` });
  }
  const sw2 = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  check("390px: forecast view keeps no horizontal page scroll", sw2);
  check("no console errors on mobile", errors.length === 0 && bad.length === 0, [...errors, ...bad].slice(0, 3).join(" | "));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
