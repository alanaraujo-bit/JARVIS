# JARVIS

Central de terminais e agentes de IA para Windows.

Um app nativo onde você abre vários terminais de tipos diferentes, liga seus
agentes de IA a pastas do computador e acompanha estatísticas reais de uso.

## Por que Tauri e não Electron

| | JARVIS (Tauri) | Apps Electron |
|---|---|---|
| Instalador | ~10 MB | ~120 MB |
| RAM em repouso | dezenas de MB | centenas de MB |
| Motor web | WebView2 já presente no Windows 11 | Chromium embutido |
| Camada de PTY | Rust falando direto com o ConPTY | ponte Node → C++ |

O núcleo pesado (leitura dos PTYs, buffers, coalescência de eventos) roda em
Rust com threads nativas; o WebView cuida só da interface.

## Estado atual

**Etapa 1 — Fundação** concluída:

- Motor de PTY em Rust: criar, escrever, redimensionar, matar, listar e
  restaurar sessões (`src-tauri/src/pty.rs`).
- Detecção automática dos shells instalados: PowerShell 7, Windows PowerShell,
  Prompt de Comando, Git Bash e WSL (`src-tauri/src/shells.rs`).
- Contrato IPC tipado nos dois lados (`src-tauri/src/protocol.rs` ↔
  `src/lib/ipc.ts`).
- Terminal na tela com xterm.js acelerado por WebGL.
- 12 testes automatizados, incluindo o motor de PTY rodando sem interface.

Próximas etapas: abas e splits, workspaces por pasta, agentes de IA,
paleta de comandos e dashboard de estatísticas.

## Rodando

```powershell
npm install
npm run app:dev     # desenvolvimento, com recarga automática
npm run app:build   # instalador NSIS em src-tauri/target/release/bundle
```

Testes:

```powershell
npm run check                      # TypeScript
cd src-tauri; cargo test           # motor de PTY
```

## Detalhe técnico que vale saber

O ConPTY do Windows é criado com `PSUEDOCONSOLE_INHERIT_CURSOR`: o conhost
manda uma consulta de posição de cursor (`ESC[6n`) e **segura o processo filho
até ser respondido**. Se essa resposta ficar por conta do terminal na interface,
cada aba nasce congelada por centenas de milissegundos — e trava de vez se a
aba abrir em segundo plano. O JARVIS responde a esse handshake no backend, no
instante em que ele aparece, e remove a sequência do fluxo para o front não
responder duas vezes. Está em `Handshake::filter`, em `src-tauri/src/pty.rs`.
