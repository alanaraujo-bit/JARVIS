import { expect, test, type Page } from "@playwright/test";

/**
 * Histórico de terminais de ponta a ponta.
 *
 * O que estes testes cobrem e os unitários não: a gravação acompanhando a
 * vida da sessão, o xterm de reprodução montando com o conteúdo certo, e — o
 * ponto todo da funcionalidade — o conteúdo continuar lá depois de a aba ter
 * sido fechada.
 */

async function abre(page: Page) {
  await page.goto("/");
  await expect(page.locator(".app")).toBeVisible();
}

async function abreTerminal(page: Page) {
  await page.locator(".launchers .chip").first().click();
  await expect(page.locator(".tab")).toHaveCount(1);
}

async function digitaNoTerminal(page: Page, texto: string) {
  await page.locator(".pane:not([hidden]) .xterm-helper-textarea").first().focus();
  await page.keyboard.type(texto);
  await page.keyboard.press("Enter");
}

/** Texto que o xterm da reprodução tem em buffer. */
async function textoDaReproducao(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector(".history-replay-host .xterm");
    if (!host) return "";
    // O xterm da reprodução usa o renderizador DOM (sem WebGL aqui), então o
    // texto está no DOM — ao contrário do terminal ao vivo.
    return (host.textContent ?? "").replace(/\s+/g, " ");
  });
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    throw new Error(`erro de JavaScript na página: ${e.message}`);
  });
  await abre(page);
});

test("grava o que passou pelo terminal e mostra no histórico", async ({ page }) => {
  await abreTerminal(page);
  await digitaNoTerminal(page, "echo lembre-se disso");

  await page.keyboard.press("Control+Shift+H");
  await expect(page.locator(".history")).toBeVisible();

  // A sessão aparece na lista e já vem selecionada.
  await expect(page.locator(".history-item")).toHaveCount(1);
  await expect(page.locator(".history-item.active")).toBeVisible();

  await expect.poll(() => textoDaReproducao(page), { timeout: 10_000 }).toContain(
    "lembre-se disso",
  );
});

test("a gravação sobrevive ao fechamento da aba — o motivo de tudo isto existir", async ({
  page,
}) => {
  await abreTerminal(page);
  await digitaNoTerminal(page, "echo contexto que nao pode sumir");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __jarvisTerminalText(): string }).__jarvisTerminalText(),
      ),
    )
    .toContain("contexto que nao pode sumir");

  // Fecha a aba: a sessão morre, o terminal some da tela. O seletor exclui
  // o botão de minimizar (`.x.minimize`, que vem antes no DOM): a aba
  // precisa morrer de verdade para a gravação ser encerrada.
  await page.locator(".tab .x:not(.minimize)").click();
  await expect(page.locator(".tab")).toHaveCount(0);

  await page.keyboard.press("Control+Shift+H");
  await expect(page.locator(".history-item")).toHaveCount(1);
  await expect.poll(() => textoDaReproducao(page), { timeout: 10_000 }).toContain(
    "contexto que nao pode sumir",
  );
});

test("a busca filtra a lista e o Esc fecha o painel", async ({ page }) => {
  await abreTerminal(page);
  await digitaNoTerminal(page, "echo um");

  await page.keyboard.press("Control+Shift+H");
  await expect(page.locator(".history-item")).toHaveCount(1);

  await page.locator(".history-list .history-search input").fill("nao-existe-em-lugar-nenhum");
  await expect(page.locator(".history-item")).toHaveCount(0);
  await expect(page.locator(".history-list .stats-empty")).toBeVisible();

  await page.locator(".history-list .history-search input").fill("");
  await expect(page.locator(".history-item")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(page.locator(".history")).toHaveCount(0);
});

test("reabrir uma sessão gravada cria uma aba na mesma pasta", async ({ page }) => {
  await abreTerminal(page);
  await digitaNoTerminal(page, "echo sessao original");
  await page.locator(".tab .x:not(.minimize)").click();
  await expect(page.locator(".tab")).toHaveCount(0);

  await page.keyboard.press("Control+Shift+H");
  await page.getByRole("button", { name: "Reabrir terminal" }).click();

  // O painel sai da frente e a aba nova assume.
  await expect(page.locator(".history")).toHaveCount(0);
  await expect(page.locator(".tab")).toHaveCount(1);
});

test("reabrir uma sessão de agente continua a conversa em vez de começar outra", async ({
  page,
}) => {
  // Um workspace que sobe o `claude` sozinho — é assim que uma aba passa a
  // ter uma conversa de IA vinculada a ela.
  await page.evaluate(() => {
    localStorage.setItem(
      "jarvis-dev-config",
      JSON.stringify({
        workspaces: [
          {
            id: "ws-agente",
            name: "Projeto com agente",
            path: "C:\\Users\\dev\\projetos\\com-agente",
            color: "#7aa2f7",
            defaultProfileId: null,
            autoCommand: "claude",
            createdAt: Date.now(),
          },
        ],
        activeWorkspaceId: "ws-agente",
      }),
    );
  });
  await abre(page);

  await abreTerminal(page);
  // O agente "sobe" com um id de sessão próprio (ver `agents::preparar_comando_inicial`).
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __jarvisTerminalText(): string }).__jarvisTerminalText(),
      ),
    )
    .toContain("claude");

  await page.locator(".tab .x:not(.minimize)").click();
  await expect(page.locator(".tab")).toHaveCount(0);

  await page.keyboard.press("Control+Shift+H");
  // A conversa encontrada é anunciada antes de o usuário decidir.
  await expect(page.locator(".history-retomada")).toBeVisible();
  await page.getByRole("button", { name: "Continuar conversa" }).click();

  await expect(page.locator(".history")).toHaveCount(0);
  await expect(page.locator(".tab")).toHaveCount(1);
  // O terminal novo nasce retomando a conversa, e não abrindo uma limpa.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __jarvisTerminalText(): string }).__jarvisTerminalText(),
      ),
    )
    .toContain("--resume");
});

test("apagar uma gravação a tira da lista", async ({ page }) => {
  await abreTerminal(page);
  await digitaNoTerminal(page, "echo descartavel");

  await page.keyboard.press("Control+Shift+H");
  await expect(page.locator(".history-item")).toHaveCount(1);

  await page.getByRole("button", { name: "Apagar esta gravação" }).click();
  await expect(page.locator(".history-item")).toHaveCount(0);
});
