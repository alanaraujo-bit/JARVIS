//! Imagem do clipboard virando arquivo em disco.
//!
//! O terminal transporta *texto*: um print no clipboard não tem como descer
//! pelo PTY. O que os agentes de IA (Claude Code, Codex, opencode) aceitam é
//! um **caminho** — eles abrem o arquivo por conta própria. Então o pulo do
//! gato é gravar o bitmap num PNG temporário e colar o caminho dele.
//!
//! A leitura é feita com `arboard` direto, e não pelo plugin de clipboard do
//! Tauri, por dois motivos: `readImage` do plugin exige a permissão
//! `clipboard-manager:allow-read-image` no capability (que não temos) e
//! devolve RGBA cru para o WebView, o que obrigaria a codificar o PNG no
//! canvas e mandar megabytes de volta pelo IPC. Aqui os bytes nunca saem do
//! Rust — o que atravessa a ponte é uma string com o caminho.

use base64::Engine as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::{JarvisError, Result};

/// Por quanto tempo um PNG colado sobrevive na pasta. A colagem é um gesto
/// de uso imediato: o agente lê o arquivo em segundos. Guardar por um dia dá
/// folga para reabrir uma conversa sem deixar a pasta crescer para sempre.
const VALIDADE: Duration = Duration::from_secs(24 * 60 * 60);

/// Teto de segurança para a decodificação. Um clipboard corrompido pode
/// anunciar dimensões absurdas; alocar `w * h * 4` às cegas com esses números
/// derruba o app (o perfil de release é `panic = "abort"`).
const MAX_PIXELS: usize = 64 * 1024 * 1024;

/// Pasta onde os PNGs colados vivem.
///
/// Fica **dentro do diretório da sessão**, e não numa pasta global do app,
/// por um motivo que só aparece quando se testa de verdade: os agentes de IA
/// tratam a pasta de trabalho como fronteira de permissão. Um caminho em
/// `%APPDATA%` faz o Claude Code responder "a leitura está fora dos
/// diretórios permitidos" e pedir aprovação a cada colagem — ou seja, a
/// colagem "funcionaria" e mesmo assim não entregaria a imagem. Dentro do
/// projeto ele abre direto.
///
/// O `.jarvis` na frente esconde a pasta do `ls` e a mantém junto do resto
/// do que é do app; o `.gitignore` escrito ali dentro evita que um print
/// colado vá parar num commit.
///
/// Sem sessão (ou com um diretório que não dá para escrever) sobra a pasta
/// global, ao lado do `config.json`: melhor uma colagem que pede permissão
/// do que colagem nenhuma.
pub fn pasta_para(cwd: Option<&str>) -> PathBuf {
    if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
        let dir = Path::new(cwd).join(".jarvis").join("clipboard");
        if fs::create_dir_all(&dir).is_ok() {
            marcar_como_ignorada(Path::new(cwd).join(".jarvis"));
            return dir;
        }
    }
    pasta_global()
}

fn pasta_global() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("JARVIS");
    path.push("clipboard");
    path
}

/// Um `.gitignore` com `*` dentro da própria pasta: funciona em qualquer
/// repositório sem editar o `.gitignore` do usuário, que é dele e não nosso.
/// Só é escrito uma vez; se já existe, fica como está.
fn marcar_como_ignorada(dir: PathBuf) {
    let arquivo = dir.join(".gitignore");
    if arquivo.exists() {
        return;
    }
    let _ = fs::write(&arquivo, "*\n");
}

/// Lê a imagem do clipboard e grava um PNG em `dir`, devolvendo o caminho.
///
/// `Ok(None)` quer dizer "não tem imagem no clipboard" — é o caso comum
/// (clipboard com texto, ou vazio) e não é erro: quem chama simplesmente
/// segue para a colagem de texto.
pub fn salvar_do_clipboard(dir: &Path) -> Result<Option<String>> {
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(c) => c,
        Err(e) => return Err(JarvisError::BadPayload(format!("clipboard: {e}"))),
    };

    let imagem = match clipboard.get_image() {
        Ok(img) => img,
        // `ContentNotAvailable` (e parentes) só significam que o formato
        // pedido não está lá. Virar erro faria a colagem de texto normal
        // aparecer como falha na cara do usuário.
        Err(_) => return Ok(None),
    };

    let png = codificar_png(imagem.width, imagem.height, &imagem.bytes)?;

    fs::create_dir_all(dir)?;
    limpar_antigos(dir, VALIDADE);

    let destino = dir.join(nome_de_arquivo());
    fs::write(&destino, png)?;

    // `canonicalize` no Windows devolve o prefixo `\\?\`, que os agentes não
    // entendem; o caminho montado aqui já é absoluto e longo (nunca 8.3),
    // então basta convertê-lo para string.
    Ok(Some(destino.to_string_lossy().to_string()))
}

fn nome_de_arquivo() -> String {
    let agora = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // O sufixo aleatório evita colisão entre duas colagens no mesmo
    // milissegundo (colar duas vezes seguidas é comum quando a primeira
    // tentativa parece não ter funcionado).
    let sufixo = uuid::Uuid::new_v4().simple().to_string();
    format!("colado-{agora}-{}.png", &sufixo[..8])
}

fn codificar_png(largura: usize, altura: usize, rgba: &[u8]) -> Result<Vec<u8>> {
    if largura == 0 || altura == 0 {
        return Err(JarvisError::BadPayload(
            "imagem do clipboard sem dimensões".into(),
        ));
    }
    let pixels = largura
        .checked_mul(altura)
        .ok_or_else(|| JarvisError::BadPayload("imagem do clipboard grande demais".into()))?;
    if pixels > MAX_PIXELS {
        return Err(JarvisError::BadPayload(
            "imagem do clipboard grande demais".into(),
        ));
    }
    if rgba.len() < pixels * 4 {
        return Err(JarvisError::BadPayload(
            "imagem do clipboard truncada".into(),
        ));
    }

    let mut saida = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut saida, largura as u32, altura as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut escritor = enc
            .write_header()
            .map_err(|e| JarvisError::BadPayload(format!("png: {e}")))?;
        escritor
            .write_image_data(&rgba[..pixels * 4])
            .map_err(|e| JarvisError::BadPayload(format!("png: {e}")))?;
    }
    Ok(saida)
}

/// Apaga os PNGs colados que passaram da validade. Falhas aqui são ignoradas
/// de propósito: não conseguir limpar o histórico não é motivo para impedir
/// a colagem que o usuário acabou de pedir.
fn limpar_antigos(dir: &Path, validade: Duration) {
    let Ok(entradas) = fs::read_dir(dir) else {
        return;
    };
    let agora = SystemTime::now();
    for entrada in entradas.flatten() {
        let caminho = entrada.path();
        if !e_arquivo_colado(&caminho) {
            continue;
        }
        let vencido = entrada
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| agora.duration_since(m).unwrap_or_default() > validade)
            .unwrap_or(false);
        if vencido {
            let _ = fs::remove_file(&caminho);
        }
    }
}

/// Só apaga o que este módulo escreveu. A pasta é nossa, mas se o usuário
/// largar um arquivo lá dentro ele não some sozinho.
fn e_arquivo_colado(caminho: &Path) -> bool {
    caminho
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with("colado-") && n.ends_with(".png"))
        .unwrap_or(false)
}

/// Mesma checagem de `e_arquivo_colado`, mais a pasta-mãe: só um PNG que este
/// módulo gravou, dentro de uma pasta chamada `clipboard` (a de sessão, em
/// `.jarvis/clipboard`, ou a global, em `%APPDATA%/JARVIS/clipboard`).
///
/// Existe para o preview de hover no terminal (`ler_como_data_url` abaixo).
/// Sem essa fronteira, um comando disparado por passar o mouse sobre um texto
/// viraria uma leitura de arquivo arbitrário — o caminho que chega aqui vem
/// do front, que por sua vez está tentando reconstruí-lo a partir do que
/// *ele mesmo* gravou, mas o IPC não tem como provar isso sozinho.
fn e_elegivel_para_preview(caminho: &Path) -> bool {
    e_arquivo_colado(caminho)
        && caminho
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n == "clipboard")
            .unwrap_or(false)
}

/// Lê de volta um PNG colado e devolve como *data URL* pronta para um
/// `<img src>` — é o que alimenta o preview ao passar o mouse no
/// "[Image #N]" que o agente mostra no terminal.
///
/// Diferente de `salvar_do_clipboard`, aqui os bytes *precisam* atravessar o
/// IPC: é o front que vai desenhar a prévia. O preço é pago só sob demanda —
/// um hover é raro perto da frequência de teclas digitadas — e o arquivo já
/// é um PNG pequeno (um print, não um vídeo).
pub fn ler_como_data_url(caminho: &Path) -> Result<String> {
    if !e_elegivel_para_preview(caminho) {
        return Err(JarvisError::BadPayload(
            "caminho fora da pasta de colagem".into(),
        ));
    }
    let bytes = fs::read(caminho)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codifica_png_valido() {
        // 2x1 RGBA: vermelho e verde.
        let rgba = [255, 0, 0, 255, 0, 255, 0, 255];
        let png = codificar_png(2, 1, &rgba).expect("deveria codificar");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "assinatura de PNG");
    }

    #[test]
    fn recusa_dimensao_zero() {
        assert!(codificar_png(0, 10, &[]).is_err());
        assert!(codificar_png(10, 0, &[]).is_err());
    }

    #[test]
    fn recusa_buffer_truncado() {
        // Anuncia 4 pixels mas entrega 1.
        assert!(codificar_png(2, 2, &[255, 0, 0, 255]).is_err());
    }

    #[test]
    fn recusa_dimensao_absurda() {
        assert!(codificar_png(usize::MAX, 2, &[]).is_err());
        assert!(codificar_png(100_000, 100_000, &[]).is_err());
    }

    #[test]
    fn nome_de_arquivo_e_reconhecido_como_colado() {
        let nome = nome_de_arquivo();
        assert!(e_arquivo_colado(Path::new(&nome)), "{nome}");
        assert!(!e_arquivo_colado(Path::new("foto-do-usuario.png")));
        assert!(!e_arquivo_colado(Path::new("colado-123.txt")));
    }

    #[test]
    fn preview_le_um_png_que_este_modulo_gravou() {
        let dir = std::env::temp_dir().join(format!("jarvis-preview-ok-{}", uuid::Uuid::new_v4()));
        let clipboard = dir.join("clipboard");
        fs::create_dir_all(&clipboard).unwrap();
        let png = codificar_png(2, 1, &[255, 0, 0, 255, 0, 255, 0, 255]).unwrap();
        let caminho = clipboard.join(nome_de_arquivo());
        fs::write(&caminho, &png).unwrap();

        let data_url = ler_como_data_url(&caminho).expect("deveria ler o preview");
        assert!(data_url.starts_with("data:image/png;base64,"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_recusa_arquivo_fora_da_pasta_clipboard() {
        let dir = std::env::temp_dir().join(format!("jarvis-preview-fora-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let caminho = dir.join(nome_de_arquivo());
        fs::write(&caminho, b"x").unwrap();

        assert!(ler_como_data_url(&caminho).is_err(), "pasta não se chama clipboard");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_recusa_arquivo_que_o_modulo_nao_escreveu() {
        let dir = std::env::temp_dir().join(format!("jarvis-preview-alheio-{}", uuid::Uuid::new_v4()));
        let clipboard = dir.join("clipboard");
        fs::create_dir_all(&clipboard).unwrap();
        let caminho = clipboard.join("foto-do-usuario.png");
        fs::write(&caminho, b"x").unwrap();

        assert!(
            ler_como_data_url(&caminho).is_err(),
            "nome não segue o padrão colado-*.png"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn limpeza_poupa_recentes_e_arquivos_de_terceiros() {
        let dir = std::env::temp_dir().join(format!("jarvis-clip-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        let recente = dir.join(nome_de_arquivo());
        let alheio = dir.join("foto-do-usuario.png");
        fs::write(&recente, b"x").unwrap();
        fs::write(&alheio, b"x").unwrap();

        // Validade de um dia: nada acabou de nascer vencido.
        limpar_antigos(&dir, VALIDADE);
        assert!(recente.exists());
        assert!(alheio.exists());

        // Validade zero: o nosso vence na hora, o de terceiro continua.
        limpar_antigos(&dir, Duration::from_secs(0));
        assert!(!recente.exists());
        assert!(alheio.exists());

        let _ = fs::remove_dir_all(&dir);
    }
}

/// Verificação manual contra o clipboard real do sistema.
///
/// Fica `#[ignore]` porque depende de um bitmap estar no clipboard *agora* —
/// numa suíte automática ele passaria ou falharia conforme o que o usuário
/// tivesse copiado. Para rodar: copie um print e execute
/// `cargo test --lib grava_o_que_esta_no_clipboard -- --ignored --nocapture`.
#[cfg(test)]
mod teste_manual {
    use super::*;

    #[test]
    #[ignore = "depende de haver uma imagem no clipboard do sistema"]
    fn grava_o_que_esta_no_clipboard() {
        let dir = std::env::temp_dir().join("jarvis-clip-manual");
        let caminho = salvar_do_clipboard(&dir).expect("leitura do clipboard falhou");
        let caminho = caminho.expect("nenhuma imagem no clipboard");
        println!("gravado em: {caminho}");
        let bytes = fs::read(&caminho).expect("PNG não foi escrito");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "assinatura de PNG");
    }
}

#[cfg(test)]
mod tests_pasta {
    use super::*;

    #[test]
    fn usa_o_diretorio_da_sessao_quando_ele_existe() {
        let base = std::env::temp_dir().join(format!("jarvis-cwd-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();

        let dir = pasta_para(Some(&base.to_string_lossy()));
        assert!(dir.starts_with(&base), "{dir:?} deveria ficar dentro de {base:?}");
        assert!(dir.exists());
        // O print colado não pode vazar para um commit do usuário.
        assert_eq!(
            fs::read_to_string(base.join(".jarvis").join(".gitignore")).unwrap(),
            "*\n"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn cai_na_pasta_global_sem_sessao() {
        assert_eq!(pasta_para(None), pasta_global());
        assert_eq!(pasta_para(Some("")), pasta_global());
    }

    #[test]
    fn cai_na_pasta_global_quando_o_diretorio_e_impossivel() {
        // Um caminho que não dá para criar (arquivo no lugar de pasta pai).
        let arquivo = std::env::temp_dir().join(format!("jarvis-nao-pasta-{}", uuid::Uuid::new_v4()));
        fs::write(&arquivo, b"x").unwrap();
        assert_eq!(pasta_para(Some(&arquivo.to_string_lossy())), pasta_global());
        let _ = fs::remove_file(&arquivo);
    }
}
