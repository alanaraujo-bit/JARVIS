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

## Rodando

```powershell
npm install
npm run app:dev     # app nativo, com recarga automática
npm run app:build   # instalador NSIS em src-tauri/target/release/bundle
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
