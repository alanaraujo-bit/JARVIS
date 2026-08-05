/**
 * Monta o `latest.json` da release atual.
 *
 * O manifesto é o que todo JARVIS instalado lê para saber se há versão nova.
 * Escrever à mão é onde o processo costuma quebrar: a `signature` é o
 * *conteúdo* do arquivo `.sig` (não o caminho), e a versão tem que bater
 * exatamente com a compilada no binário. Errar qualquer um dos dois não dá
 * erro nenhum na publicação — só faz a atualização falhar em silêncio em
 * todas as máquinas.
 *
 * No alvo NSIS o Tauri 2 assina o próprio instalador: os artefatos são
 * `...-setup.exe` e `...-setup.exe.sig`. O `.nsis.zip` que a documentação
 * mais antiga menciona não é gerado.
 *
 * Uso: node scripts/release.mjs [notas da versão]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const RAIZ = join(import.meta.dirname, "..");
const REPO = "alanaraujo-bit/JARVIS";

const pkg = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(RAIZ, "src-tauri/tauri.conf.json"), "utf8"));
const cargo = readFileSync(join(RAIZ, "src-tauri/Cargo.toml"), "utf8");
const cargoVersao = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

const versao = pkg.version;

// As três versões precisam bater. Se o Cargo ficar para trás, o binário se
// identifica com a versão antiga e o app acha que já está atualizado —
// baixa, instala, reabre e oferece a mesma atualização de novo, para sempre.
const divergentes = [
  ["package.json", pkg.version],
  ["tauri.conf.json", tauri.version],
  ["Cargo.toml", cargoVersao],
].filter(([, v]) => v !== versao);

if (divergentes.length) {
  console.error(`Versões divergentes (esperado ${versao}):`);
  for (const [arquivo, v] of divergentes) console.error(`  ${arquivo}: ${v}`);
  process.exit(1);
}

const bundle = join(RAIZ, "src-tauri/target/release/bundle/nsis");
const exe = join(bundle, `JARVIS_${versao}_x64-setup.exe`);
const sig = `${exe}.sig`;

for (const [nome, caminho] of [["instalador", exe], ["assinatura", sig]]) {
  if (!existsSync(caminho)) {
    console.error(`Falta o ${nome}: ${caminho}`);
    console.error("Rode `npm run app:build` com TAURI_SIGNING_PRIVATE_KEY_PATH definido.");
    process.exit(1);
  }
}

const manifesto = {
  version: versao,
  notes: process.argv[2] ?? `JARVIS ${versao}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sig, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/v${versao}/JARVIS_${versao}_x64-setup.exe`,
    },
  },
};

const destino = join(RAIZ, "latest.json");
writeFileSync(destino, `${JSON.stringify(manifesto, null, 2)}\n`);

console.log(`latest.json escrito para a versão ${versao}`);
console.log("\nPublique com:");
console.log(`gh release create v${versao} \\
  "${exe}" \\
  "${sig}" \\
  "${destino}" \\
  --title "JARVIS v${versao}" --notes "${manifesto.notes}"`);
