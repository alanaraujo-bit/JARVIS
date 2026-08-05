import { expect, test, type Page } from "@playwright/test";

/**
 * Minimizar abas.
 *
 * O que estes testes protegem: a sessão continuar viva por trás (é o ponto
 * todo — minimizar não é fechar), a navegação por teclado não parar numa aba
 * que não está na barra, e o estado atravessar um F5.
 */

async function abre(page: Page) {
  await page.goto("/");
  await expect(page.locator(".app")).toBeVisible();
}

async function abreTerminal(page: Page, indice = 0) {
  const antes = await page.locator(".tab").count();
  await page.locator(".launchers .chip").nth(indice).click();
  await expect(page.locator(".tab")).toHaveCount(antes + 1);
}

async function digitaNoTerminal(page: Page, texto: string) {
  await page.locator(".pane:not([hidden]) .xterm-helper-textarea").first().focus();
  await page.keyboard.type(texto);
  await page.keyboard.press("Enter");
}

const textoDoTerminal = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __jarvisTerminalText(): string }).__jarvisTerminalText(),
  );

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    throw new Error(`erro de JavaScript na página: ${e.message}`);
  });
  await abre(page);
});

test("minimizar tira a aba da barra e a bandeja a traz de volta", async ({ page }) => {
  await abreTerminal(page);
  await digitaNoTerminal(page, "echo continuo vivo");

  await page.locator(".tab").first().hover();
  await page.getByRole("button", { name: /^Minimizar / }).click();

  await expect(page.locator(".tab")).toHaveCount(0);
  await expect(page.locator(".tab-tray-chip")).toHaveCount(1);

  await page.locator(".tab-tray-chip").click();
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".tab-tray")).toHaveCount(0);
});

test("a sessão continua rodando enquanto minimizada — não é um fechar disfarçado", async ({
  page,
}) => {
  await abreTerminal(page);
  await digitaNoTerminal(page, "echo antes de minimizar");

  await page.keyboard.press("Control+Shift+M");
  await expect(page.locator(".tab-tray-chip")).toHaveCount(1);

  // O painel some da barra, mas o backend continua com a sessão de pé.
  const vivas = await page.evaluate(() =>
    (window as unknown as { __TAURI_INTERNALS__: { invoke(c: string): Promise<unknown[]> } })
      .__TAURI_INTERNALS__.invoke("pty_list"),
  );
  expect(vivas).toHaveLength(1);

  // E o conteúdo dela continua no xterm montado, sem ter sido destruído.
  await page.keyboard.press("Control+Shift+Alt+M");
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect.poll(() => textoDoTerminal(page)).toContain("antes de minimizar");
});

test("Ctrl+Tab não pára numa aba minimizada", async ({ page }) => {
  await abreTerminal(page, 0);
  await abreTerminal(page, 1);
  await abreTerminal(page, 2);
  await expect(page.locator(".tab")).toHaveCount(3);

  // Minimiza a do meio.
  await page.locator(".tab").nth(1).hover();
  await page.locator(".tab").nth(1).getByRole("button", { name: /^Minimizar / }).click();
  await expect(page.locator(".tab")).toHaveCount(2);

  // Com duas visíveis, dois Ctrl+Tab dão a volta completa e voltam ao início.
  const ativaAntes = await page.locator(".tab.active .label").innerText();
  await page.keyboard.press("Control+Tab");
  const ativaDepois = await page.locator(".tab.active .label").innerText();
  expect(ativaDepois).not.toBe(ativaAntes);
  await page.keyboard.press("Control+Tab");
  await expect(page.locator(".tab.active .label")).toHaveText(ativaAntes);

  // Em nenhum momento a tela ficou sem aba ativa.
  await expect(page.locator(".tab.active")).toHaveCount(1);
});

test("com tudo minimizado a tela avisa em vez de fingir que não há terminal", async ({ page }) => {
  await abreTerminal(page);
  await page.keyboard.press("Control+Shift+M");

  await expect(page.locator(".empty")).toBeVisible();
  await expect(page.locator(".empty")).toContainText("minimizado");
  await expect(page.locator(".empty")).not.toContainText("Escolha um shell");
});

test("o estado minimizado sobrevive a um recarregamento", async ({ page }) => {
  await abreTerminal(page, 0);
  await abreTerminal(page, 1);
  await page.locator(".tab").nth(0).hover();
  await page.locator(".tab").nth(0).getByRole("button", { name: /^Minimizar / }).click();
  await expect(page.locator(".tab")).toHaveCount(1);

  // O arranjo é salvo com meio segundo de atraso (ver o efeito em App.tsx).
  await page.waitForTimeout(900);
  await page.reload();
  await expect(page.locator(".app")).toBeVisible();

  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".tab-tray-chip")).toHaveCount(1);
});

test("fechar uma aba minimizada encerra a sessão dela", async ({ page }) => {
  await abreTerminal(page);
  await page.keyboard.press("Control+Shift+M");
  await expect(page.locator(".tab-tray-chip")).toHaveCount(1);

  await page.locator(".tab-tray-chip").click({ button: "middle" });
  await expect(page.locator(".tab-tray")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __TAURI_INTERNALS__: { invoke(c: string): Promise<unknown[]> } })
          .__TAURI_INTERNALS__.invoke("pty_list"),
      ),
    )
    .toHaveLength(0);
});
