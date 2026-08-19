# Bloqueios — sessão de 2026-08-19

Nenhum dos 4 pedidos ficou bloqueado; tudo foi implementado, testado (unit +
e2e) e verificado visualmente onde deu para verificar sem o app nativo
compilado. Só falta uma verificação manual que exige rodar o `.exe` de
verdade no Windows (o ambiente desta sessão não compila/roda o binário
Tauri nativo, só o front-end contra o backend simulado do Playwright):

## Pendente de verificação manual (não é bug conhecido, só não foi visto rodando de verdade)

1. **Ctrl+clique em caminhos do terminal** (`src/lib/pathLinks.ts`,
   `src/components/TerminalView.tsx`, comando Rust `reveal_path` em
   `src-tauri/src/commands.rs`): a extração de caminho tem 6 testes
   unitários passando e o `cargo check` compila limpo, mas nunca abriu um
   Explorer de verdade — o ambiente de dev roda só no Chromium via mock.
   Ao testar: abra um terminal, rode algo que imprima um caminho (ex.:
   `claude` citando um arquivo, ou `echo C:\...\arquivo.txt`), seg­ure Ctrl e
   clique em cima. Deve abrir o Explorer com o item selecionado.

2. **Notificação nativa do Windows** (`src/lib/activityWatcher.ts`,
   `src/lib/notifications.ts`): a lógica de "rajada de saída seguida de
   silêncio" tem 7 testes unitários passando, mas o disparo real da
   notificação do Windows (`tauri-plugin-notification`) e o pedido de
   permissão na primeira execução não foram vistos na tela — exigem o app
   nativo rodando e minimizado/em segundo plano. Ao testar: abra um
   terminal, rode um comando que demore e produza saída (ex. um `claude`
   fazendo algo), minimize o JARVIS ou troque de janela, e espere a saída
   parar. Deve aparecer uma notificação do Windows com o nome do
   projeto/aba e uma prévia das últimas linhas da tela.

## Concluído e verificado

3. **Aba mostra o nome do projeto** (`tabLabel` em `src/App.tsx`) e
   **tooltip com prévia da tela ao passar o mouse** (`tabPreview`): visto
   funcionando no Chromium — a aba trocou de "PowerShell 7" para
   "projeto-1" assim que um workspace foi associado, e o `title` nativo
   passou a incluir as últimas linhas do terminal.

4. **Bloco de notas redimensionável** (`src/stores/notesStore.ts`,
   `src/components/NotesPanel.tsx`): visto funcionando — arrastar a borda
   esquerda do painel muda a largura ao vivo (testado 360px → 513px) e o
   valor persiste (localStorage, `jarvis_vibe_notes_state`).

Nada aqui impede o uso do app; é só a lacuna entre "compila e passa nos
testes" e "visto rodando no `.exe` do Windows". Quando puder, um teste manual
rápido dos itens 1 e 2 fecha o ciclo.
