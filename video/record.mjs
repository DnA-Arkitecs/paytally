// Records the PayTally judge path on the hosted demo as sharp 1920x1080 frames
// (Chrome DevTools screencast), one folder per beat, with the moments spent
// waiting on PayPal or the host marked so the editor can cut them short.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = "https://paytally-wyzc.onrender.com";
const OUT = path.resolve("frames");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
// A visible pointer, since a headless browser draws none.
const cursorScript = () => {
  addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.id = "__cursor";
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l14 8.5-6.2 1.6L8.6 18z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "-50px", top: "-50px", zIndex: 2147483647, pointerEvents: "none", transition: "transform 80ms" });
    document.documentElement.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX - 3 + "px"; c.style.top = e.clientY - 2 + "px"; }, true);
    addEventListener("mousedown", () => { c.style.transform = "scale(0.82)"; }, true);
    addEventListener("mouseup", () => { c.style.transform = "scale(1)"; }, true);
  });
};
await ctx.addInitScript(cursorScript);
let page, cdp;

const now = () => Date.now() / 1000;
let seg = null;
const log = { segments: {} };
let frameNo = 0;
async function attach(context) {
  page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  const session = await context.newCDPSession(page);
  session.on("Page.screencastFrame", async ({ data, sessionId }) => {
    try {
      if (seg) {
        const name = String(++frameNo).padStart(6, "0") + ".jpg";
        fs.writeFileSync(path.join(OUT, seg, name), Buffer.from(data, "base64"));
        log.segments[seg].frames.push({ f: name, t: now() });
      }
      await session.send("Page.screencastFrameAck", { sessionId });
    } catch {}
  });
  cdp = session;
  mouse = { x: 800, y: 450 };
}
async function start(name) {
  seg = name;
  frameNo = 0;
  fs.mkdirSync(path.join(OUT, name), { recursive: true });
  log.segments[name] = { start: now(), frames: [], waits: [], marks: [] };
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await nudge();
}
async function stop() {
  await nudge();
  await page.waitForTimeout(250);
  log.segments[seg].stop = now();
  await cdp.send("Page.stopScreencast");
  seg = null;
  fs.writeFileSync(path.join(OUT, "timeline.json"), JSON.stringify(log, null, 1));
}
const pause = (ms) => page.waitForTimeout(ms);
const mark = (label) => seg && log.segments[seg].marks.push({ label, t: now() });
// Marks a stretch spent waiting, so the editor can shorten it.
async function waiting(fn, kind = "wait") {
  const a = now();
  const out = await fn();
  if (seg) log.segments[seg].waits.push({ a, b: now(), kind });
  return out;
}
let mouse = { x: 800, y: 450 };
async function nudge() {
  // A one-pixel move forces a fresh frame, so a still screen still has a frame at this moment.
  mouse.x += mouse.x > 5 ? -1 : 1;
  await page.mouse.move(mouse.x, mouse.y);
}
async function moveTo(x, y, steps = 18) {
  await page.mouse.move(x, y, { steps });
  mouse = { x, y };
}
async function clickEl(loc, { hold = 350 } = {}) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  await moveTo(b.x + b.width / 2, b.y + b.height / 2);
  await pause(hold);
  // Every click is marked with its label, so the editor can line the voice up with it.
  mark("click:" + ((await loc.textContent().catch(() => "")) || "").trim().replace(/\s+/g, " ").slice(0, 40));
  await page.mouse.down();
  await pause(70);
  await page.mouse.up();
}
async function smoothScroll(total, ms) {
  const steps = Math.max(1, Math.round(ms / 50));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, total / steps);
    await pause(50);
  }
}

// ---------- Off camera: wake the host ----------
await attach(ctx);
for (let i = 0; i < 12; i++) {
  const r = await page.goto(BASE, { waitUntil: "domcontentloaded" }).catch(() => null);
  if (r && r.status() === 200) break;
  await pause(10000);
}
await page.waitForLoadState("networkidle");

// ---------- Beat 1: the problem. A built demo, so the Work log tab has its rows ----------
await page.click("#reset");
await page.waitForTimeout(2000);
await page.evaluate(() => document.querySelector("details.tour")?.removeAttribute("open"));
await page.evaluate(() => window.scrollTo(0, 0));
await moveTo(1100, 300, 2);
await pause(800);
// The unbuilt home page and its headline.
await start("b1h");
await pause(5500);
await stop();
// Off camera: build, so the Work log tab has its rows; put the tab bar at the top of the screen.
await page.click("#build");
await page.waitForFunction(() => document.querySelectorAll("#grid .ag-row").length > 5, null, { timeout: 120000 });
await page.waitForTimeout(4500);
await page.click('.tab[data-tab="log"]');
await page.waitForTimeout(800);
await page.evaluate(() => {
  const t = document.querySelector('.tab[data-tab="log"]');
  window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 70);
});
await moveTo(900, 620, 2);
await pause(800);
await start("b1w");
await pause(1200);
await smoothScroll(2200, 10000);
await pause(800);
await stop();

// ---------- A fresh browser (new demo cookie), so beat 2 starts unbuilt ----------
await page.close();
const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
await ctx2.addInitScript(cursorScript);
await attach(ctx2);
await page.goto(BASE, { waitUntil: "networkidle" });
await page.click("#reset");
await page.waitForTimeout(2000);
await page.evaluate(() => document.querySelector("details.tour")?.removeAttribute("open"));
await moveTo(1100, 300, 2);

// ---------- Beat 2: Claude reads, code prices, the owner decides, PayPal invoices ----------
await page.evaluate(() => window.scrollTo(0, 0));
await page.click('.tab[data-tab="ledger"]');
await pause(400);
await start("b2");
await pause(600);
await clickEl(page.locator("#build"));
await waiting(() => page.waitForFunction(() => document.querySelectorAll("#grid .ag-row").length > 5, null, { timeout: 120000 }));
await pause(1200);
// Open one billed line: its reason and source rows.
const billed = page.locator("#grid .ag-row", { hasText: "Dana Whitfield" }).first();
await clickEl(billed);
await pause(2600);
await page.keyboard.press("Escape");
await pause(300);
await page.keyboard.press("n");
mark("flag-priya");
await pause(2800);
const openText = () => page.evaluate(() => document.querySelector("#grid .detail.flagged")?.innerText || "");
for (let guard = 0; guard < 8; guard++) {
  const t = await openText();
  if (!t) break;
  const dontBill = /Priya|Okafor/.test(t);
  mark("key:" + (dontBill ? "d" : "b"));
  await page.keyboard.press(dontBill ? "d" : "b");
  await waiting(() => page.waitForFunction((prev) => (document.querySelector("#grid .detail.flagged")?.innerText || "") !== prev, t, { timeout: 30000 }).catch(() => null));
  await pause(guard === 0 ? 1200 : 700);
}
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await pause(700);
for (let guard = 0; guard < 4; guard++) {
  const btns = page.locator("#cards button", { hasText: "Approve & send" });
  const n = await btns.count();
  if (!n) break;
  await clickEl(btns.first());
  const confirm = page.locator("#approve-dialog button.primary");
  await confirm.waitFor({ timeout: 10000 });
  await pause(900);
  await clickEl(confirm);
  await waiting(() => page.waitForFunction((k) => document.querySelectorAll("#cards button").length === 0 || [...document.querySelectorAll("#cards button")].filter((b) => b.textContent.includes("Approve & send")).length < k, n, { timeout: 60000 }));
  await pause(900);
}
await pause(1200);
await stop();

// ---------- Beat 3: the client's own AI agent settles over MCP ----------
await page.click('.tab[data-tab="agent"]');
await page.evaluate(() => window.scrollTo(0, 0));
await pause(600);
await start("b3");
await moveTo(1300, 330);
await pause(2500);
const cp = page.locator("#settle-checkpoint");
await clickEl(cp.locator("button", { hasText: "checks the invoice" }));
await waiting(() => cp.locator("button", { hasText: "Claude's call" }).waitFor({ timeout: 180000 }), "stream");
await pause(1500);
await clickEl(cp.locator("button", { hasText: "Claude's call" }));
await pause(1200);
await clickEl(cp.locator("button", { hasText: "& send reply" }));
await waiting(() => cp.locator("button", { hasText: "picks it back up" }).waitFor({ timeout: 90000 }));
await pause(1500);
await clickEl(cp.locator("button", { hasText: "picks it back up" }));
await waiting(() => cp.locator("button", { hasText: /^Approve \$/ }).waitFor({ timeout: 180000 }), "stream");
await pause(1800);
await clickEl(cp.locator("button", { hasText: /^Approve \$/ }));
await waiting(() => cp.locator(".settled").waitFor({ timeout: 120000 }));
await cp.locator(".settled").scrollIntoViewIfNeeded();
await pause(3500);
await stop();

// ---------- Beat 4: the month in AG Studio, and its Claude assistant ----------
await page.goto(BASE + "/studio.html", { waitUntil: "networkidle" });
await page.waitForTimeout(5000);
await start("b4");
await moveTo(700, 300);
await pause(1500);
await moveTo(1150, 420);
await pause(800);
await clickEl(page.getByRole("button", { name: /Edit layout/i }));
await pause(1500);
const box = page.getByPlaceholder(/Ask the AI Assistant/i);
await box.waitFor({ timeout: 15000 });
await clickEl(box);
await page.keyboard.type("Which client owes the most, and how overdue is it?", { delay: 28 });
await pause(500);
mark("ask-sent");
await page.keyboard.press("Enter");
await waiting(async () => {
  // Wait until the assistant stops "Thinking" (its answer is done), up to 3 minutes.
  await pause(3000);
  await page.waitForFunction(() => !/Thinking/.test(document.body.innerText), null, { timeout: 180000 }).catch(() => null);
}, "stream");
mark(await page.evaluate(() => (/Thinking/.test(document.body.innerText) ? "still-thinking" : "answered")));
await pause(4000);
await stop();

// ---------- Beat 5: the receipts (README results), then the product ----------
await page.goto("https://github.com/DnA-Arkitecs/paytally", { waitUntil: "networkidle" });
const results = page.locator("article.markdown-body table").first();
await results.scrollIntoViewIfNeeded().catch(() => null);
await page.evaluate(() => window.scrollBy(0, -120));
await pause(800);
await start("b5a");
await moveTo(900, 500);
await pause(3500);
await smoothScroll(250, 1500);
await pause(1000);
await stop();
await page.goto(BASE, { waitUntil: "networkidle" });
await page.evaluate(() => window.scrollTo(0, 0));
await pause(1500);
await start("b5b");
await moveTo(220, 30);
await pause(4500);
await stop();

await browser.close();
console.log("recorded:", Object.entries(log.segments).map(([k, v]) => `${k} ${v.frames.length} frames ${(v.stop - v.start).toFixed(1)}s`).join("; "));
