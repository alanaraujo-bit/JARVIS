# Bloqueios — sessão de 2026-08-19

Nenhum dos 4 pedidos ficou bloqueado. Tudo foi implementado, testado
(unit + e2e), a release **v0.18.0** foi compilada de verdade (instalador
assinado), publicada no GitHub e o `master` recebeu o push — o auto-update
do JARVIS já aponta para ela.

## Pendente de verificação manual (não é bug conhecido, só não foi clicado por um humano ainda)

O `.exe` compilou limpo e foi assinado, então as duas features abaixo
existem no binário publicado — só falta alguém confirmar na tela, já que
esta sessão não tem como abrir uma janela nativa do Windows e clicar nela:

1. **Ctrl+clique em caminhos do terminal**: abra um terminal, rode algo que
   imprima um caminho (ex.: `claude` citando um arquivo, ou
   `echo C:\...\arquivo.txt`), segure Ctrl e clique em cima. Deve abrir o
   Explorer com o item selecionado.

2. **Notificação nativa do Windows**: abra um terminal, rode um comando que
   demore e produza saída, minimize o JARVIS ou troque de janela, e espere
   a saída parar. Deve aparecer uma notificação do Windows com o nome do
   projeto/aba e uma prévia das últimas linhas da tela. Na primeira vez o
   Windows deve pedir permissão de notificação — vale conferir se o pedido
   aparece.

## Concluído e verificado (visto rodando, no Chromium ou no build real)

3. **Aba mostra o nome do projeto** + tooltip com prévia da tela: visto
   funcionando — a aba trocou de "PowerShell 7" para "projeto-1" assim que
   um workspace foi associado.

4. **Bloco de notas redimensionável**: visto funcionando — arrastar a
   borda esquerda do painel muda a largura ao vivo (360px → 513px testado)
   e persiste entre sessões.

## Release

- Versão: **v0.18.0**, tag e release no GitHub apontando para o commit
  `4e5ac26` (a tag foi recriada uma vez porque a release saiu antes do
  commit do bump de versão — corrigido com `git tag -f` + push forçado só
  da tag).
- Instalador assinado, `.sig` e `latest.json` publicados em
  https://github.com/alanaraujo-bit/JARVIS/releases/tag/v0.18.0
- `master` recebeu o push — o deploy do site no Vercel dispara sozinho
  nisso, e o painel "Procurar atualizações" do JARVIS já deve enxergar a
  v0.18.0 a partir de agora.
