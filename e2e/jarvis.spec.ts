import { expect, test, type Page } from "@playwright/test";

/**
 * Percursos de ponta a ponta na interface real, com o backend simulado.
 *
 * O que estes testes cobrem e os unitários não: montagem do xterm, ordem de
 * assinatura dos eventos de streaming, atalhos de teclado chegando à janela,
 * e persistência atravessando um F5.
 */

/**
 * Cada teste roda num contexto novo do navegador, então o `localStorage` (e
 * portanto a configuração salva pelo backend simulado) já nasce vazio. Não
 * limpe aqui com `addInitScript`: aquilo roda a cada navegação, inclusive no
 * `reload()`, e apagaria justamente o que os testes de persistência checam.
 */
async function abre(page: Page) {
  await page.goto("/");
  await expect(page.locator(".app")).toBeVisible();
}

/**
 * Texto que o xterm tem em buffer, lido pela ponte que o backend simulado
 * instala. Não dá para inspecionar o DOM aqui: com o renderizador WebGL o
 * terminal desenha num canvas e não há nó de texto para consultar.
 */
async function esperaNoTerminal(page: Page, texto: string) {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __jarvisTerminalText(): string }).__jarvisTerminalText()), {
      timeout: 10_000,
    })
    .toContain(texto);
}

async function textoDoTerminal(page: Page): Promise<string> {
  return page.evaluate(() =>
    (window as unknown as { __jarvisTerminalText(): string }).__jarvisTerminalText(),
  );
}

/**
 * Digita no terminal ativo. O xterm recebe teclado por um `<textarea>`
 * escondido; clicar na área desenhada não basta para focá-lo de forma
 * confiável fora de uma interação humana.
 */
async function digitaNoTerminal(page: Page, texto: string, enter = true) {
  await page.locator(".pane:not([hidden]) .xterm-helper-textarea").first().focus();
  await page.keyboard.type(texto);
  if (enter) await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  // Qualquer erro de JavaScript não tratado reprova o teste: sem isto, uma
  // exceção num efeito passaria despercebida enquanto a asserção principal
  // ainda encontrasse o elemento na tela.
  page.on("pageerror", (e) => {
    throw new Error(`erro de JavaScript na página: ${e.message}`);
  });
  await abre(page);
});

test("a tela vazia convida a abrir um terminal", async ({ page }) => {
  await expect(page.locator(".empty h1")).toHaveText("JARVIS");
  await expect(page.getByRole("button", { name: /PowerShell 7/ })).toBeVisible();
});

test("abrir uma aba monta o terminal e o shell responde ao que se digita", async ({ page }) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();

  await esperaNoTerminal(page, "backend simulado");

  await digitaNoTerminal(page, "echo funcionou");

  await esperaNoTerminal(page, "funcionou");
});

test("dividir cria um segundo painel e fechar volta para um", async ({ page }) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await expect(page.locator(".split-leaf")).toHaveCount(1);

  await page.getByTitle(/Dividir ao lado/).click();
  await expect(page.locator(".split-leaf")).toHaveCount(2);
  await expect(page.locator(".split-divider")).toHaveCount(1);

  // Com dois painéis aparece o botão de fechar em cada um.
  await page.locator(".pane-close").first().click();
  await expect(page.locator(".split-leaf")).toHaveCount(1);
});

test("o atalho de nova aba abre outra aba sem o texto vazar para o shell", async ({ page }) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await expect(page.locator(".tab")).toHaveCount(1);

  await page.locator(".pane:not([hidden]) .xterm-helper-textarea").first().focus();
  await page.keyboard.press("Control+Shift+T");

  await expect(page.locator(".tab")).toHaveCount(2);
  // O "T" do atalho não pode ter sido digitado no shell.
  expect(await textoDoTerminal(page)).not.toContain("T>");
});

test("abas podem ser renomeadas com duplo clique", async ({ page }) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  const aba = page.locator(".tab").first();

  await aba.dblclick();
  const campo = page.locator(".tab-rename");
  await expect(campo).toBeVisible();
  await campo.fill("build");
  await campo.press("Enter");

  await expect(aba.locator(".label")).toHaveText("build");
});

test("a paleta de comandos filtra e executa", async ({ page }) => {
  await page.keyboard.press("Control+Shift+P");
  const paleta = page.getByRole("dialog", { name: "Paleta de comandos" });
  await expect(paleta).toBeVisible();

  await page.locator(".palette-input").fill("nova aba");
  await expect(page.locator(".palette-item").first()).toContainText("Nova aba");

  await page.keyboard.press("Enter");
  await expect(paleta).toBeHidden();
  await expect(page.locator(".tab")).toHaveCount(1);
});

test("a paleta fecha com Esc e sem executar nada", async ({ page }) => {
  await page.keyboard.press("Control+Shift+P");
  await expect(page.getByRole("dialog", { name: "Paleta de comandos" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Paleta de comandos" })).toBeHidden();
  await expect(page.locator(".tab")).toHaveCount(0);
});

test("as setas navegam a paleta e a busca sem resultado avisa", async ({ page }) => {
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".palette-item.selected")).toHaveCount(1);

  await page.locator(".palette-input").fill("xyzabc123");
  await expect(page.locator(".palette-empty")).toBeVisible();
  // Enter sem resultado não pode quebrar nada.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Paleta de comandos" })).toBeVisible();
});

/** Abre o painel de contas pela paleta de comandos. */
async function abreContas(page: Page) {
  await page.keyboard.press("Control+Shift+P");
  await page.locator(".palette-input").fill("contas do claude");
  await page.keyboard.press("Enter");
  const painel = page.getByRole("dialog", { name: "Contas do Claude Code" });
  await expect(painel).toBeVisible();
  return painel;
}

test("criar uma conta e importar o login existente deixa ela pronta para uso", async ({ page }) => {
  const painel = await abreContas(page);
  await expect(painel).toContainText("Nenhuma conta cadastrada");

  await painel.getByRole("button", { name: "Nova conta" }).click();

  const item = painel.locator(".accounts-item").first();
  await expect(item).toBeVisible();
  // Conta recém-criada não tem login: é isso que faz o botão "Entrar"
  // aparecer, e some quando ela passa a ter.
  await expect(item.locator(".accounts-estado")).toHaveText("sem login");
  await expect(item.getByRole("button", { name: "Entrar" })).toBeVisible();

  await item.getByRole("button", { name: "Usar o login atual" }).click();
  await expect(item.locator(".accounts-estado")).toHaveText("PRO");
  await expect(item.getByRole("button", { name: "Entrar" })).toHaveCount(0);

  // A primeira conta vira a padrão sozinha e passa a valer para os próximos
  // terminais — o que a barra de cima tem que anunciar.
  await expect(item.locator(".accounts-tag")).toHaveText("padrão");
  await page.keyboard.press("Escape");
  await expect(page.locator(".account-badge")).toBeVisible();
});

test("a conta sobrevive ao recarregar e vale para os terminais abertos depois", async ({ page }) => {
  const painel = await abreContas(page);
  await painel.getByRole("button", { name: "Nova conta" }).click();
  await painel.locator(".accounts-item").first().getByRole("button", { name: "Usar o login atual" }).click();
  await expect(painel.locator(".accounts-estado")).toHaveText("PRO");
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.locator(".app")).toBeVisible();
  await expect(page.locator(".account-badge")).toBeVisible();

  // O terminal nasce marcado com a conta: é o ponto extra no lado da aba.
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await expect(page.locator(".tab-conta")).toHaveCount(1);
});

test("remover uma conta pede confirmação e limpa o distintivo da barra", async ({ page }) => {
  const painel = await abreContas(page);
  await painel.getByRole("button", { name: "Nova conta" }).click();
  const item = painel.locator(".accounts-item").first();
  await expect(item).toBeVisible();

  await item.getByRole("button", { name: /^Remover/ }).click();
  // Um clique não apaga: o passo de confirmação é o que separa "cliquei sem
  // querer" de "quero perder o login desta conta".
  await expect(item.getByRole("button", { name: "Apagar mesmo" })).toBeVisible();
  await expect(painel.locator(".accounts-item")).toHaveCount(1);

  await item.getByRole("button", { name: "Apagar mesmo" }).click();
  await expect(painel.locator(".accounts-item")).toHaveCount(0);
  await expect(painel).toContainText("Nenhuma conta cadastrada");

  await page.keyboard.press("Escape");
  await expect(page.locator(".account-badge")).toHaveCount(0);
});

test("o painel de uso mostra uma linha por conta", async ({ page }) => {
  const painel = await abreContas(page);
  await painel.getByRole("button", { name: "Nova conta" }).click();
  await painel.getByRole("button", { name: "Nova conta" }).click();
  await expect(painel.locator(".accounts-item")).toHaveCount(2);
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Shift+S");
  const stats = page.getByRole("dialog", { name: "Estatísticas de uso" });
  await expect(stats).toBeVisible();
  await expect(stats).toContainText("Uso por conta do Claude Code");
  await expect(stats.locator(".stats-conta")).toHaveCount(2);
});

test("o painel de uso mostra a cota ao vivo com contagem regressiva", async ({ page }) => {
  // Sem contas, a cota consultada é a da configuração principal (~/.claude):
  // o mock responde como se houvesse login e janelas de cota de verdade.
  await page.keyboard.press("Control+Shift+S");
  const stats = page.getByRole("dialog", { name: "Estatísticas de uso" });

  // Hero da cota: badge de origem + as duas janelas da Anthropic (5h e 7 dias).
  await expect(stats.locator(".stats-live-badge")).toContainText("Ao vivo");
  await expect(stats.locator(".stats-hero")).toBeVisible();
  await expect(stats.locator(".stats-janela")).toHaveCount(2);
  // O countdown do mock é 3h24min a partir da consulta; o relógio anda com o
  // painel aberto, então a asserção aceita qualquer minutos de hora em hora.
  await expect(stats.locator(".stats-janela-reset").first()).toContainText(
    /reseta em \d+h \d+min/,
  );

  // O botão de consultar de novo fica na cabeça da seção.
  await expect(stats.getByRole("button", { name: /Atualizar/ })).toBeVisible();
});

test("o painel de atualizações abre pela paleta e fecha com Esc", async ({ page }) => {
  await page.keyboard.press("Control+Shift+P");
  await page.locator(".palette-input").fill("atualiza");
  await page.keyboard.press("Enter");

  const painel = page.getByRole("dialog", { name: "Atualizações" });
  await expect(painel).toBeVisible();
  // No navegador não existe plugin nativo: o painel tem que dizer isso em
  // vez de ficar rodando um "procurando…" que nunca termina.
  await expect(painel).toContainText("aplicativo instalado");
  await expect(painel.getByRole("button", { name: /Procurar atualizações/ })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(painel).toBeHidden();
});

test("as estatísticas refletem as sessões abertas", async ({ page }) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await page.getByRole("button", { name: /Git Bash/ }).click();

  await page.keyboard.press("Control+Shift+S");
  const painel = page.getByRole("dialog", { name: "Estatísticas de uso" });
  await expect(painel).toBeVisible();

  await expect(painel.locator(".stats-card").first().locator(".stats-card-value")).toHaveText("2");
  await expect(painel).toContainText("pwsh7");
  await expect(painel).toContainText("gitbash");
});

test("o painel de IA transmite a resposta em pedaços e oferece executar o comando", async ({
  page,
}) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await page.keyboard.press("Control+Shift+I");

  const painel = page.locator(".ai-panel");
  await expect(painel).toBeVisible();

  await painel.locator(".ai-input").fill("como listo os arquivos?");
  await painel.locator(".ai-send-btn").click();

  // A resposta chega token a token; o teste só passa se o streaming acabar.
  await expect(painel.locator(".ai-msg-assistant")).toContainText("Get-ChildItem", {
    timeout: 15_000,
  });
  await expect(painel.locator(".ai-code-block")).toBeVisible();

  // O bloco é PowerShell, então ganha o botão de executar no terminal.
  await painel.locator(".ai-code-run").click();
  await esperaNoTerminal(page, "Get-ChildItem");
});

test("a conversa pode ser limpa depois que o streaming termina", async ({ page }) => {
  await page.keyboard.press("Control+Shift+I");
  const painel = page.locator(".ai-panel");
  await painel.locator(".ai-input").fill("oi");
  await painel.locator(".ai-send-btn").click();
  await expect(painel.locator(".ai-msg-assistant")).toContainText("Recebi", { timeout: 15_000 });

  // O botão de limpar só libera quando a geração acaba — limpar no meio
  // deixaria o streaming escrevendo numa mensagem já removida.
  const limpar = painel.getByTitle(/Limpar conversa/);
  await expect(limpar).toBeEnabled({ timeout: 15_000 });
  await limpar.click();
  await expect(painel.locator(".ai-welcome")).toBeVisible();
});

test("workspace escolhido sobrevive ao recarregar a página", async ({ page }) => {
  await page.keyboard.press("Control+Shift+B");
  await expect(page.locator(".ws-sidebar")).toBeVisible();

  await page.locator(".ws-add-btn").click();
  await expect(page.locator(".ws-item")).toHaveCount(1);
  await expect(page.locator(".ws-badge")).toContainText("projeto-1");

  await page.reload();
  await expect(page.locator(".ws-sidebar")).toBeVisible();
  await expect(page.locator(".ws-item")).toHaveCount(1);
  await expect(page.locator(".ws-badge")).toContainText("projeto-1");
});

test("abrir o painel de IA não fecha a barra de workspaces depois de um F5", async ({ page }) => {
  // Regressão do merge de config: as duas telas são donas de metades de
  // `ui`, e substituir o bloco inteiro fazia uma apagar o estado da outra.
  await page.keyboard.press("Control+Shift+B");
  await expect(page.locator(".ws-sidebar")).toBeVisible();
  await page.keyboard.press("Control+Shift+I");
  await expect(page.locator(".ai-panel")).toBeVisible();

  await page.reload();
  await expect(page.locator(".ws-sidebar")).toBeVisible();
  await expect(page.locator(".ai-panel")).toBeVisible();
});

test("as sessões vivas voltam depois de um recarregamento", async ({ page }) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await page.getByRole("button", { name: /Prompt de Comando/ }).click();
  await expect(page.locator(".tab")).toHaveCount(2);

  await page.reload();
  // O dono das sessões é o backend: elas voltam mesmo com o estado do React
  // zerado, uma aba por sessão.
  await expect(page.locator(".tab")).toHaveCount(2);
});

test("um shell que morre mostra o aviso e o botão de reiniciar", async ({ page }) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await digitaNoTerminal(page, "exit");

  await expect(page.locator(".pane-overlay")).toBeVisible();
  await expect(page.locator(".pane-overlay")).toContainText("Processo encerrado");

  await page.getByRole("button", { name: "Reiniciar" }).click();
  await expect(page.locator(".pane-overlay")).toBeHidden();
  await esperaNoTerminal(page, "backend simulado");
});

test("a busca no histórico abre com Ctrl+F e fecha com Esc", async ({ page }) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await esperaNoTerminal(page, "backend simulado");

  await digitaNoTerminal(page, "npm test");
  await esperaNoTerminal(page, "layout.test.ts");

  await page.locator(".pane:not([hidden]) .xterm-helper-textarea").first().focus();
  await page.keyboard.press("Control+f");

  const busca = page.locator(".term-search-input");
  await expect(busca).toBeVisible();
  await busca.fill("layout");
  await busca.press("Escape");
  await expect(busca).toBeHidden();
});

test("colar com Ctrl+V traz o clipboard para o shell", async ({ page }) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await esperaNoTerminal(page, "backend simulado");

  // O mock do plugin de clipboard tenta a API real do navegador primeiro;
  // com a permissão concedida, o texto escrito aqui é o que o Ctrl+V lê.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("git status"));
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("git status");

  await page.locator(".pane:not([hidden]) .xterm-helper-textarea").first().focus();
  await page.keyboard.press("Control+v");

  await esperaNoTerminal(page, "git status");
});

test("a barra de ditado digita no shell como se fosse o usuário", async ({ page }) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await esperaNoTerminal(page, "backend simulado");

  // Ctrl+Shift+G é atalho local do painel (o xterm o entrega ao próprio
  // terminal), então o foco precisa estar no terminal antes.
  await page.locator(".pane:not([hidden]) .xterm-helper-textarea").first().focus();
  await page.keyboard.press("Control+Shift+G");
  const barra = page.locator(".term-dictation-textarea");
  await expect(barra).toBeVisible();

  // O que entra na barra vai repassado ao shell em tempo real.
  await barra.fill("echo ditado funcionou");
  await esperaNoTerminal(page, "ditado funcionou");

  // Enter executa a linha; a barra limpa e continua aberta para a próxima
  // fala, em vez de fechar no meio da conversa.
  await page.keyboard.press("Enter");
  await expect(barra).toHaveValue("");
  await expect(barra).toBeVisible();

  // Esc fecha e devolve o foco ao terminal.
  await page.keyboard.press("Escape");
  await expect(barra).toBeHidden();
});

test("remover um workspace pede confirmação antes", async ({ page }) => {
  await page.keyboard.press("Control+Shift+B");
  await page.locator(".ws-add-btn").click();
  await expect(page.locator(".ws-item")).toHaveCount(1);

  await page.locator(".ws-remove-btn").click();
  // Nada some ainda: só aparece a pergunta, no lugar do item.
  await expect(page.locator(".ws-item")).toHaveCount(1);
  await expect(page.locator(".ws-item-confirm")).toBeVisible();

  await page.locator(".ws-confirm-actions button", { hasText: "Cancelar" }).click();
  await expect(page.locator(".ws-item")).toHaveCount(1);

  await page.locator(".ws-remove-btn").click();
  await page.locator(".ws-confirm-actions button.danger").click();
  await expect(page.locator(".ws-item")).toHaveCount(0);
});

test("as abas de um workspace carregam a cor dele", async ({ page }) => {
  await page.keyboard.press("Control+Shift+B");
  await page.locator(".ws-add-btn").click();
  await page.getByRole("button", { name: /PowerShell 7/ }).click();

  const cor = await page.locator(".ws-color-dot").first().evaluate((el) =>
    getComputedStyle(el).backgroundColor,
  );
  const corDaAba = await page.locator(".tab .dot").first().evaluate((el) =>
    getComputedStyle(el).backgroundColor,
  );
  expect(corDaAba).toBe(cor);
});

test("o painel de IA marca a resposta interrompida sem embaralhar o texto", async ({ page }) => {
  await page.keyboard.press("Control+Shift+I");
  const painel = page.locator(".ai-panel");
  await painel.locator(".ai-input").fill("me explique algo longo");
  await painel.locator(".ai-send-btn").click();

  await expect(painel.locator(".ai-msg-assistant")).toContainText("Recebi");
  await painel.locator(".ai-cancel-btn").click();

  await expect(painel.locator(".ai-msg-note")).toHaveText("Interrompido por você.");
  // O marcador é um elemento próprio, não markdown cru dentro da resposta.
  await expect(painel.locator(".ai-msg-assistant")).not.toContainText("_(cancelado)_");
});

test("as configurações de IA não deixam salvar com a chave em branco", async ({ page }) => {
  await page.keyboard.press("Control+Shift+I");
  await page.locator(".ai-panel").getByTitle("Configurações de IA").click();

  await page.locator(".ai-field-select").selectOption("openai");
  await expect(page.locator(".ai-field-hint")).toContainText("chave de API");
  await expect(page.getByRole("button", { name: "Salvar" })).toBeDisabled();

  await page.locator('input[type="password"]').fill("sk-teste");
  await expect(page.getByRole("button", { name: "Salvar" })).toBeEnabled();
});

test("a janela estreita não força rolagem horizontal na página", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await page.keyboard.press("Control+Shift+B");
  await page.keyboard.press("Control+Shift+I");
  await expect(page.locator(".ai-panel")).toBeVisible();
  // Espera a animação de entrada dos painéis terminar.
  await page.waitForTimeout(400);

  const { largura, documento } = await page.evaluate(() => ({
    largura: window.innerWidth,
    documento: document.body.scrollWidth,
  }));
  expect(documento).toBeLessThanOrEqual(largura);

  // E os botões da topbar continuam alcançáveis pelo mouse.
  await expect(page.getByTitle(/Paleta de comandos/)).toBeVisible();
  await expect(page.getByTitle(/Estatísticas de uso/)).toBeVisible();
});

test("atalhos não disparam enquanto se digita num campo da interface", async ({ page }) => {
  await page.keyboard.press("Control+Shift+I");
  const campo = page.locator(".ai-input");
  await campo.click();
  await campo.fill("texto");

  // Ctrl+Shift+S abriria as estatísticas se o atalho não respeitasse o foco.
  await page.keyboard.press("Control+Shift+S");
  await expect(page.getByRole("dialog", { name: "Estatísticas de uso" })).toBeHidden();
});

test("as divisões de painel sobrevivem a um recarregamento", async ({ page }) => {
  await page.getByRole("button", { name: /PowerShell 7/ }).click();
  await page.getByTitle(/Dividir ao lado/).click();
  await expect(page.locator(".split-leaf")).toHaveCount(2);
  await expect(page.locator(".split-divider")).toHaveCount(1);

  // O arranjo é gravado com atraso para não escrever a cada arraste.
  await page.waitForTimeout(900);
  await page.reload();

  // Uma aba só, com os dois painéis lado a lado — e não duas abas soltas.
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".split-leaf")).toHaveCount(2);
  await expect(page.locator(".split-divider")).toHaveCount(1);
});

test("renomear um workspace seleciona o texto antigo em vez de concatenar", async ({ page }) => {
  await page.keyboard.press("Control+Shift+B");
  await page.locator(".ws-add-btn").click();
  const item = page.locator(".ws-item").first();

  await item.dblclick();
  const campo = page.locator(".ws-rename-input");
  await expect(campo).toBeVisible();
  await campo.fill("Meu Projeto");
  await campo.press("Enter");

  await expect(item.locator(".ws-name")).toHaveText("Meu Projeto");
});
