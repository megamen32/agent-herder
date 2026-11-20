// Drive the built inspector in a disposable browser in the plugin stand's network namespace.
import assert from "node:assert/strict";
import { chromium } from "/fixture/playwright/index.mjs";

const [base, session, format, before, action] = process.argv.slice(2);
const target = base + "/api/autopilot/sessions/codex/" + encodeURIComponent(session);
const browser = await chromium.launch({ executablePath: "/fixture/chrome/chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const control = page.getByRole("switch", { name: "Автопилот для текущей сессии", exact: true });
try {
  page.setDefaultTimeout(10000);
  await page.goto(base + "/#/session/codex:" + session, { waitUntil: "domcontentloaded" });
  await control.waitFor({ state: "visible" });
  assert.equal(await control.isChecked(), before === "true");
  const enabled = action === "click" ? before !== "true" : before === "true";
  if (action === "click") {
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url() === target && r.request().method() === "PUT"),
      control.click(),
    ]);
    assert.equal(response.status(), 200);
    const changed = await response.json();
    assert.equal(changed.sessionId, session);
    assert.equal(changed.enabled, enabled);
    await page.locator('[aria-label="Автопилот для текущей сессии"][aria-checked="' + enabled + '"]').waitFor();
  }
  const response = await page.request.get(target + "?cwd=/stand/project");
  assert.equal(response.status(), 200);
  const receipt = await response.json();
  assert.equal(receipt.sessionId, session);
  assert.equal(receipt.enabled, await control.isChecked());
  if (format === "current") await page.screenshot({path: "/receipt/inspector-current-" + enabled + ".png"});
  console.log(JSON.stringify(receipt));
} catch (error) {
  await page.screenshot({path: "/receipt/inspector-" + format + "-failure.png"}).catch(() => {});
  console.error((await page.locator("body").innerText().catch(() => "")).slice(0, 1400));
  throw error;
} finally {
  await browser.close();
}
