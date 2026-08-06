/**
 * Captura as telas do menu novo para inspeção visual.
 * Uso: node shot-menu.mjs <destino>
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "shots-menu";
mkdirSync(out, { recursive: true });

// Sobe o Vite numa porta própria e derruba ao final (mesmo contrato do
// playwright.config.ts, para não adotar um servidor que já esteja rodando).
const vite = spawn("npm.cmd", ["run", "dev", "--", "--port", "5199", "--strictPort"], {
  stdio: "ignore",
  shell: true,
});

async function esperaServidor() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch("http://localhost:5199");
      if (r.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("vite não subiu a tempo");
}

try {
  await esperaServidor();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[console]", m.text());
  });

  const aplicaTema = (modo) =>
    page.evaluate((m) => {
      document.documentElement.setAttribute("data-theme", m);
      document.documentElement.style.colorScheme = m;
    }, modo);

  // ---------- introdução ----------
  await page.goto("http://localhost:5199", { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.setItem("jarvis-dev-config", JSON.stringify({ ui: { onboardingDone: false } }));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/onboarding-boas-vindas.png` });

  await page.getByRole("button", { name: "Começar" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/onboarding-aparencia.png` });

  await page.getByRole("button", { name: "Continuar" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/onboarding-atalhos.png` });

  await page.getByRole("button", { name: "Entrar no JARVIS" }).click();
  await page.waitForTimeout(400);

  // ---------- app com o rail ----------
  await page.screenshot({ path: `${out}/rail-home.png` });

  // Configurações (escopo no rail: o painel de IA também tem um botão
  // chamado "Configurações de IA" que casaria com o nome parcial)
  const rail = page.locator(".nav-rail");
  const vaiPara = (nome) => rail.getByRole("button", { name: nome }).click();

  await vaiPara("Configurações");
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${out}/settings-dark.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Perfil
  await vaiPara("Perfil");
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${out}/profile-dark.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Estatísticas
  await vaiPara("Estatísticas");
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${out}/stats-dark.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Configurações no tema claro
  await aplicaTema("light");
  await page.waitForTimeout(400);
  await vaiPara("Configurações");
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${out}/settings-light.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await vaiPara("Perfil");
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${out}/profile-light.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Rail no tema claro
  await page.screenshot({ path: `${out}/rail-light.png` });

  // ---------- terminal aberto com o rail ----------
  await aplicaTema("dark");
  await page.locator(".launchers .chip").first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/rail-terminal.png` });

  await browser.close();
  console.log("ok");
} finally {
  vite.kill();
}
