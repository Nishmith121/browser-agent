// Phase 2 acceptance: sensitive values never appear in the outgoing JSON, and the Privacy view shows black boxes.
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PASSWORD = "Pw!421141x";
const OTP = "482915";
const ext = resolve("../extension/dist");
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ps-")), {
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1280, height: 800 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto("http://localhost:8080/demobank/login");
await page.fill("#username", "user00");
await page.fill("#password", PASSWORD);
await page.evaluate((otp) => {
  const d = document.createElement("p");
  d.id = "otp-note";
  d.textContent = `Your one time code is ${otp}`;
  document.querySelector("main").append(d);
}, OTP);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8080/*" }))[0].id);

const panelP = ctx.waitForEvent("page");
await sw.evaluate(
  (u) => chrome.windows.create({ url: u, type: "popup", width: 700, height: 1200 }),
  `chrome-extension://${id}/src/sidepanel/index.html?tab=${tabId}`,
);
const panel = await panelP;
await panel.waitForLoadState();
await panel.fill("#secret-password", PASSWORD);
await panel.fill("#secret-otp", OTP);
await panel.click("#save-secrets");
await panel.waitForFunction(() => document.getElementById("vault-info").textContent.includes("PASSWORD"));

await panel.click("#capture");
await panel.waitForFunction(() => document.getElementById("json").textContent.length > 10, null, { timeout: 90000 });
const err = await panel.textContent("#err");
const json = await panel.textContent("#json");
const guard = await panel.textContent("#guard");
const info = await panel.textContent("#info");
console.log("info:", info);
console.log("error:", JSON.stringify(err), "guard:", JSON.stringify(guard));

const failures = [];
if (err) failures.push("capture error " + err);
if (json.includes(PASSWORD)) failures.push("PASSWORD in outgoing JSON");
if (json.includes(OTP)) failures.push("OTP in outgoing JSON");
if (!json.includes("[REDACTED_SECRET]")) failures.push("vault text not replaced");
const payload = JSON.parse(json);
const pwEl = payload.elements.find((e) => e.type === "password");
if (!pwEl?.redacted || pwEl.label !== "Password") failures.push("password element not redacted with label kept");

// Pixel check on the redacted image: far-right inside the password box and the OTP text box must be black.
const px = await panel.evaluate(async (pwBox) => {
  const img = document.getElementById("shot");
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const s = img.naturalWidth / 1280;
  const at = (x, y) => Array.from(g.getImageData(Math.floor(x * s), Math.floor(y * s), 1, 1).data.slice(0, 3));
  const [x, y, w, h] = pwBox;
  return { pw: at(x + w - 12, y + h - 5), clean: at(x - 40, y) };
}, pwEl.bbox);
console.log("pixels:", JSON.stringify(px));
if (px.pw.some((v) => v > 20)) failures.push("password box is not black");

await panel.screenshot({ path: "phase2.png", fullPage: true });
await ctx.close();
if (failures.length) {
  console.error("FAIL:", failures.join("; "));
  process.exit(1);
}
console.log("PHASE2 OK");
