import { expect, test, type Page } from "@playwright/test";

/**
 * Introdução de primeira execução.
 *
 * O backend simulado marca a introdução como já vista por padrão (os testes
 * funcionais precisam da interface pronta, sem apresentação na frente), então
 * esta suíte força `ui.onboardingDone: false` no config simulado antes da
 * recarga que mostra a tela de verdade.
 *
 * Cobrem-se os dois caminhos: pular direto para a interface e percorrer os
 * passos até o fim — incluindo a persistência da flag, que é o que garante a
 * introdução não voltar a cada F5 de quem já a viu.
 */

async function forcaPrimeiraExecucao(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    // O merge do mock é campo a campo dentro de `ui`, então só a flag basta.
    localStorage.setItem(
      "jarvis-dev-config",
      JSON.stringify({ ui: { onboardingDone: false } }),
    );
  });
  await page.reload();
  await expect(page.locator(".onboarding")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    throw new Error(`erro de JavaScript na página: ${e.message}`);
  });
});

test("na primeira execução a introdução aparece e pular leva direto ao app", async ({
  page,
}) => {
  await forcaPrimeiraExecucao(page);

  await expect(
    page.getByRole("heading", { name: "Bem-vindo ao JARVIS" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Pular introdução" }).click();

  await expect(page.locator(".onboarding")).toHaveCount(0);
  await expect(page.locator(".app")).toBeVisible();
});

test("percorrer os passos termina no app, marca a escolha de tema e não volta depois", async ({
  page,
}) => {
  await forcaPrimeiraExecucao(page);

  await page.getByRole("button", { name: "Começar" }).click();

  // Passo 2 — Aparência: escolher um tema deixa a marcação nele.
  const temaEscuro = page.getByRole("button", { name: /Escuro/ });
  await temaEscuro.click();
  await expect(temaEscuro).toHaveClass(/selected/);

  await page.getByRole("button", { name: "Continuar" }).click();

  // Passo 3 — Atalhos.
  await page.getByRole("button", { name: "Entrar no JARVIS" }).click();

  await expect(page.locator(".onboarding")).toHaveCount(0);

  // Concluir grava a flag no config simulado — espera a gravação chegar ao
  // localStorage antes do F5, senão a recarga corre contra o save.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const cfg = JSON.parse(localStorage.getItem("jarvis-dev-config") ?? "{}") as {
          ui?: { onboardingDone?: boolean };
        };
        return cfg.ui?.onboardingDone ?? false;
      }),
    )
    .toBe(true);

  await page.reload();
  await expect(page.locator(".onboarding")).toHaveCount(0);
  await expect(page.locator(".app")).toBeVisible();
});
