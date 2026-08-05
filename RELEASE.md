# Publicando uma versão

Três coisas precisam acontecer juntas, ou o auto-update quebra: o número da
versão sobe em todos os arquivos, o instalador é assinado com a chave certa,
e o `latest.json` sobe junto com ele na release.

## A chave de assinatura

Fica em `~/.jarvis/updater.key` (fora do repositório, de propósito) e **não
tem backup**. Se ela sumir, nenhum JARVIS já instalado aceitará atualizações
suas nunca mais — a única saída seria todo mundo reinstalar na mão, com uma
chave nova. Copie o arquivo para algum lugar seguro.

A chave pública correspondente está em `src-tauri/tauri.conf.json`, no campo
`plugins.updater.pubkey`. As duas são um par: trocar uma exige trocar a outra.

## Passo a passo

1. **Suba a versão nos três lugares.** Os três precisam bater — o updater
   compara o que está no `latest.json` com o que foi compilado no binário:
   - `package.json` → `version`
   - `src-tauri/tauri.conf.json` → `version`
   - `src-tauri/Cargo.toml` → `version`

2. **Rode a suíte.**
   ```
   npm run test:all
   ```

3. **Compile o instalador assinado.** Rode no **Git Bash**, não no PowerShell:
   ```bash
   cd /c/Users/"Alan Araujo"/Projetos/JARVIS
   export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.jarvis/updater.key")"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
   npm run app:build
   ```

   Dois detalhes, cada um custando dois minutos de compilação quando se erra:

   - É o **conteúdo** da chave que vai na variável, não o caminho.
     `TAURI_SIGNING_PRIVATE_KEY_PATH` aparece na mensagem do `signer
     generate`, mas o bundler não lê essa variante.
   - A chave não tem senha, e **o PowerShell não consegue expressar isso**:
     `$env:VAR = ""` apaga a variável em vez de defini-la como vazia. O Tauri
     conclui que deve perguntar a senha, não há ninguém para responder, e o
     build morre com "Wrong password". No Bash, `export VAR=""` cria a
     variável vazia de verdade.

   Sem assinatura não sai o `.sig`, e sem ele não há atualização automática:
   um instalador não assinado é recusado por todos os apps instalados.

   Saem em `src-tauri/target/release/bundle/nsis/`:
   - `JARVIS_<versão>_x64-setup.exe` — o instalador, que é também o pacote
     que o updater baixa
   - `JARVIS_<versão>_x64-setup.exe.sig` — a assinatura

   No alvo NSIS o Tauri 2 assina o próprio instalador. O `.nsis.zip` que a
   documentação mais antiga menciona não é gerado.

4. **Monte o `latest.json`.**
   ```
   npm run release:manifest -- "O que mudou nesta versão."
   ```
   O script confere se as três versões batem, lê a assinatura do `.sig` e
   escreve o manifesto. Ele também imprime o comando pronto do passo 5.

5. **Publique a release** com os dois artefatos mais o manifesto — é o
   comando que o passo anterior imprimiu:
   ```
   gh release create v0.2.0 \
     "src-tauri/target/release/bundle/nsis/JARVIS_0.2.0_x64-setup.exe" \
     "src-tauri/target/release/bundle/nsis/JARVIS_0.2.0_x64-setup.exe.sig" \
     "latest.json" \
     --title "JARVIS v0.2.0" --notes "..."
   ```

   O `latest.json` **precisa** estar na release mais nova: o endpoint
   configurado é `/releases/latest/download/latest.json`, e o GitHub resolve
   `latest` para a última release publicada. Uma release sem esse arquivo faz
   a checagem de update falhar em silêncio para todo mundo.

## O que acontece sozinho

- **O site.** `website/script.js` pergunta à API do GitHub qual é o
  instalador da última release e reaponta o botão de download. Não há nome de
  arquivo fixo em lugar nenhum — publicar a release já atualiza o site. O
  deploy do site em si é o do Vercel, no push para `master`.
- **Os apps instalados.** Checam o endpoint alguns segundos depois de abrir e
  mostram o aviso quando encontram versão maior.

## Cuidado conhecido

Quem está numa versão **anterior à 0.2.0** não recebe aviso nenhum: o updater
só passou a existir na 0.2.0. Essas pessoas precisam baixar do site uma vez.
