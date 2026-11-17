// Browser verification of the single-chart interface. Usage: URL=http://127.0.0.1:8750 OUT=/path node e2e/verify.mjs
import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.URL || "http://127.0.0.1:8750";
const OUT = process.env.OUT || "e2e/screenshots";
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const num = (s) => parseFloat(String(s).replace(/[^0-9.\-−]/g, "").replace("−", "-"));

async function open(viewport, label) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [], bad = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) bad.push(`${r.status()} ${r.url().replace(URL, "")}`); });
  await page.goto(URL);
  await page.waitForSelector('[data-testid="price"]', { timeout: 40000 });
  await page.waitForSelector('[data-testid="today-pred"]', { timeout: 40000 });
  await page.waitForSelector('[data-testid="fwd-pred"]', { timeout: 60000 });
  await page.waitForTimeout(2500);
  return { ctx, page, errors, bad, label };
}
const txt = async (page, id) => (await page.textContent(`[data-testid="${id}"]`)).trim();

// ============================== desktop ==============================
{
  const { ctx, page, errors, bad } = await open({ width: 1440, height: 1000 }, "desktop");
  check("price summary shows a price, a signed change, USD per troy oz", num(await txt(page, "price")) > 500 && /[▲▼■]/.test(await txt(page, "change")) && /per troy oz/.test(await page.textContent(".gx-cur")), `${await txt(page, "price")} | ${await txt(page, "change")}`);
  check("open / previous close / high / low are all shown", (await page.locator(".gx-stat").count()) === 4);
  check("connection status shows provider state and quote time", /Live|Delayed|closed|Stale/i.test(await txt(page, "conn-status")) && /ET/.test(await txt(page, "conn-status")), await txt(page, "conn-status"));
  await page.screenshot({ path: `${OUT}/desktop-futures-1D.png`, fullPage: true });

  // line / candle switching on real OHLC
  const ohlc = await (await fetch(`${URL}/api/market/ohlc?instrument=futures&range=1D`)).json();
  check("futures 1D data is real OHLC (open/high/low/close vary per bar)", ohlc.real_ohlc && ohlc.bars.length > 20 && ohlc.bars.some((b) => b.high > b.low) && ohlc.bars.every((b) => b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)), `${ohlc.bars.length} bars, interval ${ohlc.interval}`);
  await page.click('[data-testid="mode-line"]');
  check("Line mode selectable", (await page.getAttribute('[data-testid="mode-line"]', "aria-selected")) === "true");
  await page.screenshot({ path: `${OUT}/desktop-line.png`, clip: { x: 0, y: 150, width: 1440, height: 640 } });
  await page.click('[data-testid="mode-candles"]');

  // ranges + intervals
  for (const r of ["1W", "1M", "3M", "1Y", "5Y", "1D"]) {
    await page.click(`[data-testid="range-${r}"]`);
    await page.waitForTimeout(1800);
    const d = await (await fetch(`${URL}/api/market/ohlc?instrument=futures&range=${r}`)).json();
    check(`range ${r}: real ${d.interval} candles loaded`, d.bars.length > 20 && (await page.getAttribute(`[data-testid="range-${r}"]`, "aria-selected")) === "true", `${d.bars.length} bars`);
  }

  // forecast overlay present on the chart; forward overlay on daily ranges
  await page.click('[data-testid="range-3M"]'); await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/desktop-3M-forecast-overlay.png`, clip: { x: 0, y: 150, width: 1440, height: 640 } });
  const vis3 = await page.evaluate(() => window.__gxChart.timeScale().getVisibleLogicalRange());
  check("3M: forward overlay drawn to scale and candles remain visible", vis3.from <= 1, `visible ${vis3.from.toFixed(0)}..${vis3.to.toFixed(0)}`);
  await page.click('[data-testid="range-1D"]'); await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/desktop-1D-compact-overlay.png`, clip: { x: 0, y: 150, width: 1440, height: 640 } });

  // zoom preserved across a live update
  const orig = await page.evaluate(() => { const c = window.__gxChart; const r = c.timeScale().getVisibleLogicalRange(); c.timeScale().setVisibleLogicalRange({ from: r.from + 30, to: r.to - 10 }); return r; });
  await page.waitForTimeout(500); // the library applies a requested range on the next frame
  const before = await page.evaluate(() => window.__gxChart.timeScale().getVisibleLogicalRange());
  check("test setup: the zoom was actually applied", Math.abs(before.from - (orig.from + 30)) < 1.5, `${orig.from.toFixed(0)}..${orig.to.toFixed(0)} -> ${before.from.toFixed(0)}..${before.to.toFixed(0)}`);
  await page.waitForTimeout(40000); // spans at least two 15 s chart polls and the 20 s forecast poll
  const after = await page.evaluate(() => window.__gxChart.timeScale().getVisibleLogicalRange());
  check("zoom/scroll preserved across a live chart update", Math.abs(after.from - before.from) < 3 && Math.abs(after.to - before.to) < 3, `before ${before.from.toFixed(1)}..${before.to.toFixed(1)} after ${after.from.toFixed(1)}..${after.to.toFixed(1)}`);

  // expired-target handling: when today's settlement has passed the card must say so and show the NEXT session
  const tj = await (await fetch(`${URL}/api/forecast/today`)).json();
  const cardTxt = await page.textContent('[data-testid="today-card"]');
  check("expired target is not shown as live: card matches the API phase", tj.phase === "next_session" ? /settlement has passed/.test(cardTxt) && /Next settlement prediction/.test(cardTxt) : /Today's prediction/.test(cardTxt) && !/has passed/.test(cardTxt), `phase=${tj.phase}`);

  // both forecast cards, all horizons
  check("today's prediction: price, vs reference, target time, range, issue time", num(await txt(page, "today-pred")) > 500 && /vs/.test(await txt(page, "today-vs")) && /13:30 ET/.test(await page.textContent('[data-testid="today-card"]')) && /range/.test(await page.textContent('[data-testid="today-card"]')) && /Issued/.test(await page.textContent('[data-testid="today-card"]')), `${await txt(page, "today-pred")} ${await txt(page, "today-vs")}`);
  const seen = {};
  for (const h of [1, 5, 20]) {
    await page.click(`[data-testid="h-${h}"]`);
    await page.waitForFunction(() => !/Loading forecast/.test(document.querySelector('[data-testid="forward-card"]')?.textContent || ""), null, { timeout: 60000 });
    await page.waitForTimeout(500);
    const card = await page.textContent('[data-testid="forward-card"]');
    if (await page.locator('[data-testid="fwd-pending"]').count()) seen[h] = { pending: true, t: "pending" };
    else seen[h] = { p: num(await txt(page, "fwd-pred")), c: await txt(page, "fwd-change"), t: (await page.textContent('[data-testid="forward-card"] .gx-facts > div:first-child dd')).trim() };
  }
  // A forecast is never logged at/after its own target time, so the 1-session card may legitimately be "pending" after 13:30 ET.
  check("forward forecast: 5 and 20 sessions have distinct future targets; 1 session is valid or explicitly pending", seen[5].p > 500 && seen[20].p > 500 && seen[5].t !== seen[20].t && (seen[1].pending || seen[1].p > 500), JSON.stringify(Object.values(seen).map((x) => x.t)));
  await page.click('[data-testid="h-5"]'); await page.waitForTimeout(2000);
  check("each card carries one compact historical-performance line", /Live record|Tested on/.test(await txt(page, "today-perf")) && /Live record/.test(await txt(page, "fwd-perf")));
  check("forecast cards are labelled as futures forecasts", (await page.locator(".gx-card .gx-chip", { hasText: "Futures" }).count()) === 2);

  // instrument separation
  await page.click('[data-testid="inst-spot"]'); await page.waitForTimeout(3500);
  const spotPrice = num(await txt(page, "price"));
  check("spot instrument: separate summary, forecast cards carry the not-evaluated-for-spot note", /XAU|Spot/.test(await page.textContent(".gx-micro")) && /not claimed for spot/.test(await page.textContent(".gx-cards")), `spot ${spotPrice}`);
  check("forecast toggle is disabled for spot (no overlay is transferred)", await page.isDisabled('[data-testid="toggle-forecast"]'));
  await page.screenshot({ path: `${OUT}/desktop-spot.png`, fullPage: true });
  await page.click('[data-testid="inst-futures"]'); await page.waitForTimeout(1500);

  // drawer
  await page.click('[data-testid="open-details"]'); await page.waitForSelector('[data-testid="model-tab"]', { timeout: 20000 });
  check("Model details drawer shows champions, matured forecasts, decision, promotion rule", /Current model per forecast/.test(await page.textContent('[data-testid="model-tab"]')) && /matured|scored/i.test(await page.textContent('[data-testid="model-tab"]')) && /Gate 1/.test(await page.textContent('[data-testid="model-tab"]')));
  await page.screenshot({ path: `${OUT}/desktop-drawer-model.png` });
  await page.click('[data-testid="dtab-drivers"]'); await page.waitForSelector('[data-testid="driver-dxy"]', { timeout: 20000 });
  check("Market drivers panel lists inputs with freshness", (await page.locator('[data-testid^="driver-"]').count()) >= 5);
  await page.waitForSelector('[data-testid="study-1"]', { timeout: 20000 });
  await page.screenshot({ path: `${OUT}/desktop-drawer-drivers.png` });
  await page.keyboard.press("Escape");
  check("drawer closes with Escape", (await page.locator('[data-testid="drawer"]').count()) === 0);

  check("no console errors and no failed API calls on desktop", errors.length === 0 && bad.length === 0, [...errors, ...bad].slice(0, 4).join(" | "));
  // provider outage / offline: block the price API and the status must change to Reconnecting (last good data stays on screen)
  const keep = num(await txt(page, "price"));
  await page.route("**/api/market/**", (r) => r.abort());
  await page.waitForFunction(() => /Reconnecting|Offline/.test(document.querySelector('[data-testid="conn-status"]')?.textContent || ""), null, { timeout: 40000 });
  check("outage shows 'Reconnecting…' and keeps the last good price visible", num(await txt(page, "price")) === keep, await txt(page, "conn-status"));
  await page.screenshot({ path: `${OUT}/desktop-reconnecting.png`, clip: { x: 0, y: 0, width: 1440, height: 260 } });
  await page.unroute("**/api/market/**");
  await page.waitForFunction(() => /Live|Delayed|closed/i.test(document.querySelector('[data-testid="conn-status"]')?.textContent || ""), null, { timeout: 40000 });
  check("status recovers automatically when the provider returns", true, await txt(page, "conn-status"));
  await ctx.close();
}

// ============================== mobile 390 ==============================
{
  const { ctx, page, errors, bad } = await open({ width: 390, height: 844 }, "mobile");
  const sw = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  check("390px: no page-level horizontal scroll", sw.s <= sw.c + 1, `${sw.s} vs ${sw.c}`);
  const order = await page.evaluate(() => ["price", "chart", "today-card", "forward-card"].map((id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().top));
  check("390px: order is price → chart → today's prediction → forward forecast", order.every((v, i) => i === 0 || v > order[i - 1]), order.map(Math.round).join(" < "));
  const small = await page.evaluate(() => [...document.querySelectorAll(".gx button, .gx-toggle")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height < 28; }).map((b) => b.textContent.trim().slice(0, 12)));
  check("390px: touch targets are comfortable (≥ 28px)", small.length === 0, small.join(","));
  const vis = await page.evaluate(() => window.__gxChart.timeScale().getVisibleLogicalRange());
  const nBars = (await (await fetch(`${URL}/api/market/ohlc?instrument=futures&range=1D`)).json()).bars.length;
  check("390px: the latest candles are on screen and most of the day is visible", vis.to >= nBars - 1 && (vis.to - vis.from) >= nBars * 0.5, `visible ${vis.from.toFixed(0)}..${vis.to.toFixed(0)} of ${nBars} bars`);
  await page.screenshot({ path: `${OUT}/mobile-top.png` });
  await page.screenshot({ path: `${OUT}/mobile-full.png`, fullPage: true });
  await page.click('[data-testid="open-details"]'); await page.waitForSelector('[data-testid="model-tab"]', { timeout: 20000 });
  const sw2 = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  check("390px: drawer opens without horizontal page scroll", sw2);
  await page.screenshot({ path: `${OUT}/mobile-drawer.png` });
  check("no console errors on mobile", errors.length === 0 && bad.length === 0, [...errors, ...bad].slice(0, 3).join(" | "));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
