// Asks the AG Studio assistant "What needs a decision" and logs its panel every 10 s for up to 3 minutes.
import { chromium } from "playwright";
const BASE = "https://paytally-wyzc.onrender.com";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
const page = await ctx.newPage();
await page.goto(BASE + "/studio.html", { waitUntil: "networkidle" });
await page.waitForTimeout(5000);
await page.getByRole("button", { name: /Edit layout/i }).click();
await page.waitForTimeout(2000);
await page.getByRole("button", { name: /What needs a decision/i }).click();
const panel = () => page.evaluate(() => {
  const t = document.body.innerText.replace(/\s+/g, " ");
  const i = t.indexOf("at stake on each?");
  return (i >= 0 ? t.slice(i, i + 700) : "(question not found)");
});
for (let i = 1; i <= 18; i++) {
  await page.waitForTimeout(10000);
  const t = await panel();
  console.log(`${i * 10}s:`, t);
  if (!/Thinking|Running a query/i.test(t)) break;
}
await page.screenshot({ path: "probe-assistant.png" });
await browser.close();
