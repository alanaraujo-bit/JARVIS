//! O aplicativo do celular, servido pela mesma porta da sala.
//!
//! A ideia inteira cabe numa frase: **a porta que já aceita o convidado
//! também entrega a tela dele**. Não há segundo servidor, segunda porta,
//! segundo túnel nem hospedagem em lugar nenhum — o `https://…` que o
//! `cloudflared` publica é ao mesmo tempo a origem do PWA e o destino do
//! WebSocket. Isso não é economia de código: é o que faz a página poder abrir
//! `wss://` de volta para si mesma sem CORS, sem certificado próprio e sem a
//! pessoa ter que digitar endereço nenhum.
//!
//! Os arquivos vão embutidos no executável (`include_bytes!`), e não lidos do
//! disco. Um caminho relativo resolvido em tempo de execução é a diferença
//! entre "funciona aqui" e "funciona na máquina de quem instalou": o app
//! roda de `Program Files`, do desktop ou de um pendrive, e o PWA precisa
//! existir nos três casos.
//!
//! ## O que é servido antes de alguém provar quem é
//!
//! Tudo aqui é público por necessidade — é a tela de entrada, ninguém pode
//! se autenticar antes de recebê-la. Por isso o conteúdo é rigorosamente
//! inerte: HTML, CSS, JS e dois ícones. Nada nestes bytes revela nome de
//! usuário, caminho de pasta, lista de terminais ou o código da sala. Quem
//! baixar tudo isto sem o código tem em mãos um formulário de login bonito e
//! mais nada.

use std::sync::OnceLock;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Um arquivo do PWA, com a etiqueta que evita reenviá-lo.
struct Arquivo {
    rota: &'static str,
    mime: &'static str,
    bytes: &'static [u8],
    etag: String,
}

/// Onde o `vite build -c vite.mobile.config.ts` deposita a saída. Os nomes
/// são fixos (e não hasheados como no build do desktop) porque quem resolve
/// cache aqui é o `ETag`, e um nome estável é o que deixa o service worker
/// pedir sempre o mesmo recurso.
macro_rules! embutido {
    ($caminho:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/webapp/", $caminho))
    };
}

macro_rules! icone {
    ($caminho:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/icons/", $caminho))
    };
}

fn arquivos() -> &'static [Arquivo] {
    static TABELA: OnceLock<Vec<Arquivo>> = OnceLock::new();
    TABELA.get_or_init(|| {
        let cru: &[(&'static str, &'static str, &'static [u8])] = &[
            ("/index.html", "text/html; charset=utf-8", embutido!("index.html")),
            ("/app.js", "text/javascript; charset=utf-8", embutido!("app.js")),
            ("/app.css", "text/css; charset=utf-8", embutido!("app.css")),
            ("/sw.js", "text/javascript; charset=utf-8", embutido!("sw.js")),
            (
                "/manifest.webmanifest",
                "application/manifest+json; charset=utf-8",
                embutido!("manifest.webmanifest"),
            ),
            ("/icon-512.png", "image/png", icone!("icon.png")),
            ("/icon-192.png", "image/png", icone!("128x128@2x.png")),
        ];
        cru.iter()
            .map(|(rota, mime, bytes)| Arquivo {
                rota,
                mime,
                bytes,
                etag: etiqueta(bytes),
            })
            .collect()
    })
}

/// FNV-1a de 64 bits sobre o conteúdo. Não é hash criptográfico e não
/// precisa ser: a única pergunta que um `ETag` responde é "mudou?", e quem
/// escreve estes bytes é o próprio build.
fn etiqueta(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    format!("\"{h:016x}\"")
}

/// Tempo para o cabeçalho inteiro chegar. Um cliente que abre o socket e
/// escreve um byte por minuto seguraria uma tarefa nossa de graça.
const PRAZO_PEDIDO: Duration = Duration::from_secs(10);

/// Teto do cabeçalho. Bem acima de qualquer pedido real de navegador e bem
/// abaixo do que valeria a pena alocar para um cliente hostil.
const MAX_CABECALHO: usize = 8 * 1024;

/// Política de segurança da página.
///
/// `connect-src` precisa de `ws:`/`wss:` — é literalmente o motivo de a
/// página existir. `style-src` aceita inline porque o xterm.js posiciona o
/// cursor e as linhas por atributo `style`, e reescrever o renderizador dele
/// para usar classes não compraria segurança nenhuma aqui: não há conteúdo
/// de terceiros nesta origem para se aproveitar disso.
const CSP: &str = "default-src 'self'; \
script-src 'self'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data:; \
font-src 'self'; \
connect-src 'self' ws: wss:; \
object-src 'none'; \
base-uri 'none'; \
form-action 'none'; \
frame-ancestors 'none'";

/// Responde um pedido HTTP e fecha.
///
/// Sem `keep-alive` de propósito: o navegador abre algumas conexões, pega o
/// app e passa o resto da sessão no WebSocket. Manter o estado de conexões
/// persistentes para economizar cinco handshakes por sessão seria pagar
/// complexidade num lugar onde ela não rende nada.
pub async fn atender(mut stream: TcpStream) {
    let Some(pedido) = ler_pedido(&mut stream).await else {
        let _ = stream.shutdown().await;
        return;
    };

    let cabeca_apenas = pedido.metodo == "HEAD";
    if pedido.metodo != "GET" && !cabeca_apenas {
        responder(&mut stream, 405, "text/plain; charset=utf-8", b"Metodo nao suportado", None).await;
        return;
    }

    // `/` é o app; o resto casa por rota exata. Sem fallback de SPA: uma rota
    // desconhecida devolvendo o `index.html` transformaria erro de digitação
    // em tela em branco misteriosa, e este app tem uma tela só.
    let rota = if pedido.caminho == "/" {
        "/index.html"
    } else {
        pedido.caminho.as_str()
    };

    let Some(arq) = arquivos().iter().find(|a| a.rota == rota) else {
        responder(&mut stream, 404, "text/plain; charset=utf-8", b"Nao encontrado", None).await;
        return;
    };

    // O navegador já tem esta versão: 304 e nenhum byte de corpo. É o que faz
    // a segunda abertura do app ser instantânea mesmo sem o service worker.
    if pedido.if_none_match.as_deref() == Some(arq.etag.as_str()) {
        responder(&mut stream, 304, arq.mime, b"", Some(&arq.etag)).await;
        return;
    }

    let corpo: &[u8] = if cabeca_apenas { b"" } else { arq.bytes };
    responder(&mut stream, 200, arq.mime, corpo, Some(&arq.etag)).await;
}

struct Pedido {
    metodo: String,
    caminho: String,
    if_none_match: Option<String>,
}

async fn ler_pedido(stream: &mut TcpStream) -> Option<Pedido> {
    let mut buf = Vec::with_capacity(1024);
    let mut pedaco = [0u8; 1024];

    let leitura = async {
        loop {
            let n = stream.read(&mut pedaco).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&pedaco[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                return Some(());
            }
            if buf.len() > MAX_CABECALHO {
                return None;
            }
        }
    };
    tokio::time::timeout(PRAZO_PEDIDO, leitura).await.ok()??;

    let texto = String::from_utf8_lossy(&buf);
    let mut linhas = texto.split("\r\n");
    let mut primeira = linhas.next()?.split(' ');
    let metodo = primeira.next()?.to_string();
    let alvo = primeira.next()?;

    // A query fica de fora do roteamento; o fragmento (`#c=…`, onde viaja o
    // código da sala) nem chega aqui — o navegador não o envia, e é
    // exatamente por isso que ele é o lugar certo para o código: não entra em
    // log de servidor, de proxy nem de túnel.
    let caminho = alvo.split(['?', '#']).next().unwrap_or("/").to_string();

    let mut if_none_match = None;
    for linha in linhas {
        if linha.is_empty() {
            break;
        }
        let Some((chave, valor)) = linha.split_once(':') else {
            continue;
        };
        if chave.eq_ignore_ascii_case("if-none-match") {
            if_none_match = Some(valor.trim().to_string());
        }
    }

    Some(Pedido {
        metodo,
        caminho,
        if_none_match,
    })
}

async fn responder(
    stream: &mut TcpStream,
    codigo: u16,
    mime: &str,
    corpo: &[u8],
    etag: Option<&str>,
) {
    let motivo = match codigo {
        200 => "OK",
        304 => "Not Modified",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };

    let mut cabecalho = format!(
        "HTTP/1.1 {codigo} {motivo}\r\n\
         Content-Type: {mime}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Referrer-Policy: no-referrer\r\n\
         Content-Security-Policy: {CSP}\r\n\
         Cache-Control: no-cache\r\n",
        corpo.len(),
    );
    if let Some(tag) = etag {
        cabecalho.push_str(&format!("ETag: {tag}\r\n"));
    }
    cabecalho.push_str("\r\n");

    let _ = stream.write_all(cabecalho.as_bytes()).await;
    if !corpo.is_empty() {
        let _ = stream.write_all(corpo).await;
    }
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toda_rota_declarada_existe_e_tem_etiqueta_propria() {
        let arqs = arquivos();
        assert!(arqs.iter().any(|a| a.rota == "/index.html"));
        assert!(arqs.iter().any(|a| a.rota == "/app.js"));
        assert!(arqs.iter().any(|a| a.rota == "/sw.js"));
        assert!(arqs.iter().any(|a| a.rota == "/manifest.webmanifest"));

        // Dois arquivos diferentes não podem compartilhar `ETag`: seria um
        // 304 entregando o conteúdo errado, e o sintoma (app carregando o
        // CSS no lugar do JS) não apontaria para cá nunca.
        for a in arqs {
            for b in arqs {
                if a.rota != b.rota && a.bytes != b.bytes {
                    assert_ne!(a.etag, b.etag, "{} e {} colidiram", a.rota, b.rota);
                }
            }
        }
    }

    #[test]
    fn a_etiqueta_muda_quando_o_conteudo_muda() {
        assert_ne!(etiqueta(b"a"), etiqueta(b"b"));
        assert_eq!(etiqueta(b"igual"), etiqueta(b"igual"));
        // Formato que o navegador reconhece: aspas incluídas.
        assert!(etiqueta(b"x").starts_with('"') && etiqueta(b"x").ends_with('"'));
    }
}
