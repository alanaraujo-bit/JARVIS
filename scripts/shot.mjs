/**
 * Captura a interface nos dois temas para inspeção visual.
 * Uso: node shot.mjs <destino>
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? ".";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("pageerror", (e) => console.error("[pageerror]", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("[console]", m.text());
});

await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
await page.waitForTimeout(600);

for (const modo of ["dark", "light"]) {
  await page.evaluate((m) => {
    document.documentElement.setAttribute("data-theme", m);
    document.documentElement.style.colorScheme = m;
  }, modo);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/vazio-${modo}.png` });
}

// Abre um terminal e o painel de IA para ver o app com conteúdo.
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
const chip = page.locator(".launchers .chip").first();
if (await chip.count()) {
  await chip.click();
  await page.waitForTimeout(800);
  await chip.click();
  await page.waitForTimeout(800);
}
await page.keyboard.press("Control+Shift+I");
await page.waitForTimeout(500);
await page.keyboard.press("Control+Shift+B");
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/cheio-dark.png` });

await page.evaluate(() => {
  document.documentElement.setAttribute("data-theme", "light");
  document.documentElement.style.colorScheme = "light";
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/cheio-light.png` });

await browser.close();
console.log("ok");
