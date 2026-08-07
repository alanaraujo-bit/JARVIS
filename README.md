# JARVIS

Central de terminais e agentes de IA para Windows.

Um app nativo onde você abre vários terminais de tipos diferentes, liga seus
agentes de IA a pastas do computador e acompanha estatísticas reais de uso.

## Por que Tauri e não Electron

| | JARVIS (Tauri) | Apps Electron |
|---|---|---|
| Instalador | 2,5 MB (medido) | ~120 MB |
| Executável | 5,4 MB | dezenas de MB + runtime |
| Motor web | WebView2 já presente no Windows 11 | Chromium embutido |
| Camada de PTY | Rust falando direto com o ConPTY | ponte Node → C++ |

Os dois primeiros números saem de `npm run app:build` nesta máquina
(`JARVIS_0.1.0_x64-setup.exe`, perfil release com LTO e `strip`).

O núcleo pesado (leitura dos PTYs, buffers, coalescência de eventos) roda em
Rust com threads nativas; o WebView cuida só da interface.

## O que já funciona

**Fundação.** Motor de PTY em Rust sobre o ConPTY: criar, escrever,
redimensionar, matar, listar e restaurar sessões (`src-tauri/src/pty.rs`).
Detecção automática dos shells instalados — PowerShell 7, Windows PowerShell,
Prompt de Comando, Git Bash e WSL (`src-tauri/src/shells.rs`). Contrato IPC
tipado nos dois lados (`src-tauri/src/protocol.rs` ↔ `src/lib/ipc.ts`).
Terminal na tela com xterm.js acelerado por WebGL.

**Abas e painéis.** Abas renomeáveis e reordenáveis por arraste, divisão
horizontal e vertical em árvore, divisores arrastáveis, e reinício de um shell
que morreu sem perder o painel. Busca no histórico com `Ctrl+F`, e
copiar/colar em `Ctrl+Shift+C` / `Ctrl+Shift+V` — o `Ctrl+C` continua sendo
interrupção, mesmo com texto selecionado.

**Workspaces.** Uma pasta de projeto vira um workspace com nome e cor; os
terminais novos nascem no diretório dele, e as abas carregam a cor do projeto.
Cada workspace pode ter um shell preferido. A escolha sobrevive ao fechamento
do app.

**Agente de IA.** Painel de chat com streaming token a token, falando com
Ollama, OpenAI, Anthropic ou Gemini. O agente recebe como contexto a pasta do
workspace, o shell ativo e as últimas linhas visíveis do terminal — então dá
para colar um erro de build e perguntar "o que é isso?". Blocos de código
sugeridos têm botão para executar direto no terminal ativo.

**Contas do Claude Code.** Várias contas cadastradas no app, cada uma com sua
pasta de configuração isolada, e um terminal pode nascer em qualquer uma delas
— sem `logout`/`login` no meio do caminho. Um projeto pode fixar sua conta, e
o painel de uso mostra quanto cada conta consumiu nas últimas 5h e 24h. Veja
[Contas do Claude Code](#contas-do-claude-code).

**O terminal no celular.** A sala de trabalho compartilhado serve, na mesma
porta, um aplicativo web que o celular abre e instala. Você aponta a câmera
para o QR do convite e cai direto no terminal do computador — com o Claude
Code rodando nele, acesso à pasta do projeto e tudo o mais. Veja
[O terminal no celular](#o-terminal-no-celular).

**Paleta de comandos** (`Ctrl+Shift+P`) com busca por subsequência, e
**dashboard de estatísticas** (`Ctrl+Shift+S`) alimentado pelos contadores que
o motor de PTY já mantém.

## Atalhos

| Atalho | Ação |
|---|---|
| `Ctrl+Shift+P` | Paleta de comandos |
| `Ctrl+Shift+T` | Nova aba |
| `Ctrl+Shift+W` | Fechar painel |
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | Dividir ao lado / abaixo |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Próxima / aba anterior |
| `Ctrl+1`…`Ctrl+9` | Ir para a aba N |
| `Ctrl+Alt+Setas` | Navegar entre painéis |
| `Ctrl+Shift+B` | Barra de workspaces |
| `Ctrl+Shift+O` | Abrir pasta de projeto |
| `Ctrl+Shift+I` | Painel do JARVIS AI |
| `Ctrl+Shift+S` | Estatísticas de uso |
| `Ctrl+F` | Buscar no histórico do terminal |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copiar / colar |
| `F2` | Renomear a aba (ou o workspace) em foco |

As combinações evitam de propósito `Ctrl+T`, `Ctrl+W` e `Alt+Seta`, que os
shells já reivindicam para transpor caractere, apagar palavra e mover o cursor.
Nenhum atalho dispara enquanto se digita num campo da própria interface — mas
todos funcionam com o terminal em foco, que é onde eles precisam funcionar.

## Contas do Claude Code

A CLI `claude` guarda login, preferências e histórico num único diretório
(`~/.claude`) e respeita a variável `CLAUDE_CONFIG_DIR`. É só disso que o
recurso é feito: cada conta cadastrada no JARVIS ganha uma pasta em
`%APPDATA%/JARVIS/claude-accounts/<id>`, e o terminal que a usa nasce com
`CLAUDE_CONFIG_DIR` apontando para lá. Duas contas podem rodar ao mesmo tempo,
em abas diferentes, sem nenhuma interferir na outra.

**Cadastrando.** `Ctrl+Shift+P` → "Contas do Claude Code" → *Nova conta*. A
pasta nasce semeada com o `settings.json` e o `CLAUDE.md` da sua configuração
principal — sem isso cada conta nova se comportaria diferente das outras sem
explicação. Depois, ou *Usar o login atual* (copia o login que já existe em
`~/.claude`) ou *Entrar*, que abre um terminal já na pasta certa com o `claude`
rodando para você fazer `/login` uma vez.

**Escolhendo qual conta.** Em ordem de precedência:

1. a escolha manual da paleta ("Usar a conta X nos próximos terminais");
2. a conta fixada no projeto ativo ("Fixar a conta X no projeto…");
3. a conta padrão do app.

O distintivo pontilhado na barra de cima mostra o resultado dessa conta —
onde o próximo `claude` vai rodar de verdade — e cada aba ganha um ponto na
cor da conta em que ela nasceu. Terminais já abertos não mudam de conta:
a troca vale para os próximos.

**Quanto sobrou.** O painel de estatísticas (`Ctrl+Shift+S`) lê a pasta de
cada conta e mostra tokens em 5h/24h e custo estimado por conta. A janela de
5h é a aproximação mais próxima do limite da Anthropic que dá para calcular
com o que fica gravado localmente — não é o contador oficial.

**O que fica separado.** Tudo: login, `settings.json`, `CLAUDE.md`, MCP
servers e histórico de conversas. Uma conta não enxerga nada da outra, e é
por isso que o `settings.json` que o painel edita é o da conta padrão.

> Um aviso honesto: alternar contas para contornar limite de uso é tratado
> como circunvenção pela política de uso da Anthropic, com risco de suspensão.
> Manter contas separadas por contexto (pessoal, trabalho, cliente) é uso
> normal — a ferramenta serve aos dois casos, a escolha é sua.

## O terminal no celular

A porta que aceita um convidado também entrega a tela dele. Não há segundo
servidor, segunda porta nem hospedagem em lugar nenhum: o mesmo endereço é a
origem do aplicativo web e o destino do WebSocket, e é isso que permite à
página abrir `wss://` de volta para si mesma sem CORS e sem certificado
próprio. Os arquivos vão embutidos no executável (`collab/webapp.rs`), porque
um caminho lido do disco é a diferença entre "funciona aqui" e "funciona na
máquina de quem instalou".

**Como usar.** `Ctrl+Shift+P` → *Trabalho compartilhado* → abrir a sala.
Marque os terminais que quer expor — a sala nasce vazia, e compartilhar é
sempre um segundo gesto. Aponte a câmera do celular para o QR do convite. O
código da sala viaja no fragmento da URL (`#c=…`), que o navegador **não**
envia ao servidor: ele não entra em log de acesso, de proxy nem do túnel.

Pela rede local funciona no mesmo Wi-Fi. Para usar de fora, ligue o endereço
público — o `cloudflared` abre um túnel de dentro para fora e devolve um
`https://` que desemboca no listener local, sem abrir porta no roteador. Esse
endereço é sorteado a cada sessão, então o fluxo é escanear o QR quando o
computador liga; instalar pela tela de início vale enquanto o endereço durar.

**A largura do terminal.** Um celular em pé não tem 80 colunas legíveis. O
app entra na mesma negociação de tamanho que os painéis do computador já
fazem entre si — o PTY fica do tamanho do menor painel aberto — e o celular é
só mais um painel, estreito. A consequência é real e está dita na tela: com o
ajuste ligado, o terminal encolhe **também no computador**. Desligue no painel
e você vê as colunas do computador com a letra menor. O ajuste é desfeito
quando a conexão morre, seja por qual motivo for.

**O que o celular alcança.** Exatamente os terminais marcados, e nada além.
Não existe mensagem no protocolo para abrir terminal, executar programa, ler
arquivo, listar pasta ou mudar a própria permissão — a superfície inteira são
os quatro métodos de `PtyAccess` em `collab/server.rs`. Ainda assim, um
terminal em modo `rw` com o Claude Code dentro é acesso à máquina: mantenha a
aprovação manual ligada quando o endereço for público.

**Service worker e HTTPS.** O app só fica instalável pelo túnel: service
worker exige origem segura, e a rede local é `http://`. Pela LAN ele funciona
como página normal — rápida, só não instalável.

Para inspecionar o app sem abrir o JARVIS, há uma sala de bancada com um PTY
que devolve o eco:

```powershell
cargo test --test qa_collab_e2e sala_de_bancada -- --ignored --nocapture
# abre o endereço impresso (também gravado em src-tauri/target/bancada.txt)
```

## Rodando

```powershell
npm install
npm run app:dev     # app nativo, com recarga automática
npm run app:build   # instalador NSIS em src-tauri/target/release/bundle
npm run dev:mobile  # só o app do celular, em http://localhost:5174
```

Só a interface, no navegador, sem compilar o Rust:

```powershell
npm run dev         # http://localhost:5173, com um backend simulado
```

Fora do app nativo não existe processo Rust, então `src/lib/devMock.ts` entra
no lugar: terminais de mentira que ecoam o que se digita e uma IA que responde
em streaming. É o que permite mexer no visual com recarga instantânea — e é
sobre isso que os testes de ponta a ponta rodam.

## Testes

```powershell
npm run test:all              # TypeScript + unitários + navegador
cd src-tauri; cargo test      # motor de PTY e parsing dos provedores de IA
```

Os testes de ponta a ponta (`e2e/`) abrem o Chromium de verdade e exercitam
montagem do xterm, atalhos chegando à janela, streaming da IA e persistência
atravessando um F5 — coisas que teste unitário não alcança.

## Detalhes que exigiram investigação

**O ConPTY segura o processo filho até alguém responder.** O conhost do
Windows 11 cria o pseudoconsole com `PSEUDOCONSOLE_INHERIT_CURSOR`, manda uma
consulta de posição de cursor (`ESC[6n`) e **bloqueia o filho até ser
respondido**. Se a resposta ficasse por conta do terminal na interface, cada
aba nasceria congelada por centenas de milissegundos — e travaria de vez se a
aba abrisse em segundo plano. O backend responde ao handshake no instante em
que ele aparece e remove a sequência do fluxo, para o front não responder
duas vezes (`Handshake::filter`, em `src-tauri/src/pty.rs`).

**Um chunk de HTTP não é uma linha.** Os provedores de IA mandam a resposta
como fluxo de linhas, mas o corpo chega picado por tamanho de pacote: uma
linha JSON vem partida em dois chunks, e um caractere acentuado pode ter seus
bytes divididos entre eles. Decodificar cada chunk isolado — o caminho óbvio —
corrompe acentos e descarta toda linha que atravesse a fronteira. O fluxo passa
por um buffer de **bytes** que só entrega linhas completas
(`src-tauri/src/ai.rs`).

**Cancelar precisa acordar a leitura, não só marcar uma flag.** Uma flag
consultada entre chunks não tem efeito nenhum num fluxo que parou de enviar
bytes: a leitura fica pendurada para sempre e o painel trava em "gerando" até
o app reiniciar. O cancelamento usa um `Notify` que interrompe a espera na
hora, com um watchdog de inatividade como rede de segurança.

**Os ouvintes de streaming entram antes do disparo.** Os eventos são nomeados
por id de requisição. Se o id só existisse depois do `invoke` retornar, o
front assinaria tarde demais — um Ollama local emite os primeiros tokens em
milissegundos, e numa resposta curta o próprio `done` chegaria antes do
ouvinte. O id é gerado no front justamente para inverter essa ordem.

**Config é salvo por fatias, não inteiro.** A barra de workspaces e o painel de
IA gravam de forma independente. Se cada um mandasse o documento completo que
leu antes de editar, o último a gravar apagaria a mudança do outro. Cada tela
manda só a sua fatia e o merge acontece no backend, sob lock.

**O `Viewport` do xterm agenda um timer que não cancela.** Ele chama
`setTimeout(() => this.syncScrollArea())` no próprio construtor e não guarda o
handle. Descartar o terminal antes desse timer disparar o faz acordar com o
serviço de renderização já zerado. Acontece de verdade: o StrictMode monta e
desmonta no mesmo tick, e o usuário provoca o mesmo ao fechar um painel
recém-aberto. O descarte espera um macrotask por causa disso.
