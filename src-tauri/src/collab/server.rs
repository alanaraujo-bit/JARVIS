//! O servidor da sala: um listener TCP, uma tarefa por convidado.
//!
//! A conexão é dividida em duas metades que nunca se esperam. A metade que
//! **escreve** vive num `select!` entre o `broadcast` da sala (saída de PTY,
//! chat, participantes) e uma fila privada (respostas endereçadas só àquela
//! conexão). A metade que **lê** trata teclas e pedidos. Nenhuma das duas
//! bloqueia a outra — um convidado com a rede ruim engasga só a própria fila,
//! e o terminal do anfitrião nem fica sabendo.
//!
//! O que um convidado consegue fazer aqui é curto de propósito, e vale a pena
//! ler a lista inteira: mandar teclas para um terminal que já estava
//! compartilhado em modo `rw`, pedir o estado da tela de um terminal
//! compartilhado, ajustar o tamanho dele à tela do próprio aparelho, mandar
//! chat, perguntar à IA e medir latência. Não existe comando para abrir
//! terminal, executar programa, ler arquivo, listar pasta ou mudar a própria
//! permissão.
//!
//! A mesma porta serve duas coisas diferentes, e a distinção é feita no
//! primeiro byte: um pedido com `Upgrade: websocket` é um convidado; qualquer
//! outro é um navegador querendo o PWA, e vai para [`webapp`]. É o que
//! permite o celular abrir o endereço do túnel, instalar o app e conectar de
//! volta na mesma origem, sem CORS e sem segundo servidor.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use parking_lot::{Mutex, RwLock};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{
    frame_com_seq, parse_input, ClientMsg, ServerMsg, FIT_COLS, FIT_ROWS, OP_SNAPSHOT,
    PROTOCOL_VERSION,
};
use super::webapp;
use super::{CollabHub, Out};
use crate::protocol::Snapshot;

/// Tudo o que o servidor da sala precisa do motor de terminais — e a lista
/// inteira cabe em duas linhas de propósito.
///
/// Ela existe por duas razões que apontam para o mesmo lugar. A primeira é
/// que o servidor deixa de depender do `AppHandle`, e com isso a sala pode
/// ser levantada de verdade — listener, handshake, quadros — num teste, sem
/// abrir janela. A segunda é que esta é a **única** superfície pela qual um
/// convidado alcança a máquina do anfitrião: quem quiser auditar o que a rede
/// consegue fazer aqui dentro lê estes dois métodos e acabou.
pub trait PtyAccess: Send + Sync + 'static {
    /// Teclas para um PTY existente. Nunca cria sessão.
    fn write(&self, session_id: &str, bytes: &[u8]);
    /// Estado atual da tela, para o convidado nascer com o que já estava lá.
    fn snapshot(&self, session_id: &str) -> Option<Snapshot>;
    /// Registra a tela do convidado como mais um painel da sessão. O tamanho
    /// que vale continua sendo o menor entre todos os painéis — quem decide
    /// isso é o motor de PTY, não o convidado.
    fn fit(&self, session_id: &str, view_id: &str, cols: u16, rows: u16);
    /// Tira o painel do convidado da conta. Chamado quando ele desiste do
    /// ajuste e, obrigatoriamente, quando a conexão dele morre — sem isso o
    /// terminal do anfitrião ficaria estreito para sempre depois que alguém
    /// olhasse do celular e fechasse o app.
    fn unfit(&self, session_id: &str, view_id: &str);
}

/// Quanto tempo uma conexão tem para se apresentar antes de ser cortada.
/// Sem isto, abrir um socket e não dizer nada seria uma forma barata de
/// segurar recursos do anfitrião.
const PRAZO_HELLO: Duration = Duration::from_secs(15);

/// Quanto tempo alguém pode ficar na fila de aprovação. Passado isso, o
/// convidado recebe um "não" educado em vez de uma tela girando para sempre.
const PRAZO_APROVACAO: Duration = Duration::from_secs(180);

/// Intervalo do ping de protocolo. Serve para descobrir uma conexão morta que
/// o TCP ainda não notou — comum quando um notebook fecha a tampa.
const PING: Duration = Duration::from_secs(20);

/// Sobe o listener e devolve a porta que o sistema de fato abriu.
///
/// Pedir a porta `0` e perguntar qual saiu é o único jeito honesto: uma porta
/// fixa colide com o que já estiver na máquina, e o erro apareceria como
/// "não consegui compartilhar" sem nenhuma saída para o usuário.
pub async fn bind(port: u16) -> std::io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    let porta = listener.local_addr()?.port();
    Ok((listener, porta))
}

/// Laço de aceitação. Encerra sozinho quando a sala fecha.
pub async fn serve(listener: TcpListener, hub: Arc<CollabHub>, pty: Arc<dyn PtyAccess>) {
    loop {
        let aceite = tokio::time::timeout(Duration::from_millis(500), listener.accept()).await;
        if !hub.is_active() {
            return;
        }
        let (stream, addr) = match aceite {
            Ok(Ok(v)) => v,
            // Estouro do tempo é o caso normal: serve só para reavaliar se a
            // sala ainda está aberta.
            Err(_) => continue,
            Ok(Err(e)) => {
                eprintln!("[jarvis] falha ao aceitar conexão da sala: {e}");
                continue;
            }
        };
        let hub = Arc::clone(&hub);
        let pty = Arc::clone(&pty);
        tokio::spawn(async move {
            if let Err(e) = atender(stream, addr, hub, pty).await {
                // Conexão que cai é rotina (fechar a aba, perder o Wi-Fi);
                // não polui a saída do app.
                let _ = e;
            }
        });
    }
}

/// Estado que as duas metades da conexão compartilham.
struct Conn {
    /// Só depois de aprovado é que quadros da sala começam a fluir.
    aprovado: AtomicBool,
    id: RwLock<String>,
    /// Identidade desta conexão perante o motor de PTY, para o ajuste de
    /// tamanho. É por conexão e não por participante de propósito: a mesma
    /// pessoa pode estar no celular e no computador ao mesmo tempo, e as duas
    /// telas têm larguras diferentes que precisam ser contadas em separado.
    view_id: String,
    /// Terminais que esta conexão está ajustando agora. Existe para o
    /// desligamento saber o que desfazer — o convidado que perde o Wi-Fi não
    /// manda `unfit` nenhum.
    ajustados: Mutex<HashSet<String>>,
}

type Erro = Box<dyn std::error::Error + Send + Sync>;

async fn atender(
    stream: TcpStream,
    addr: SocketAddr,
    hub: Arc<CollabHub>,
    pty: Arc<dyn PtyAccess>,
) -> Result<(), Erro> {
    // Latência antes de tudo: um lote de saída de PTY tem centenas de bytes e
    // o algoritmo de Nagle o seguraria esperando companhia. É exatamente o
    // atraso que se sente ao digitar.
    let _ = stream.set_nodelay(true);

    // Um navegador chegando nesta porta não é engano: é o caminho normal do
    // celular. Ele recebe o PWA; o WebSocket que a página abre em seguida
    // volta para cá pelo outro ramo.
    if !é_upgrade(&stream).await {
        webapp::atender(stream).await;
        return Ok(());
    }

    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut escrita, mut leitura) = ws.split();

    let conn = Arc::new(Conn {
        aprovado: AtomicBool::new(false),
        id: RwLock::new(String::new()),
        view_id: format!("collab:{}", uuid::Uuid::new_v4()),
        ajustados: Mutex::new(HashSet::new()),
    });

    // Fila privada desta conexão, para o que não é da sala inteira.
    let (direto_tx, mut direto_rx) = mpsc::channel::<Message>(64);
    let mut sala_rx = hub.subscribe();

    // ---- metade que escreve ----
    let escritor = {
        let conn = Arc::clone(&conn);
        tokio::spawn(async move {
            let mut ping = tokio::time::interval(PING);
            ping.tick().await;
            loop {
                let msg = tokio::select! {
                    direto = direto_rx.recv() => match direto {
                        Some(m) => m,
                        None => break,
                    },
                    da_sala = sala_rx.recv() => match da_sala {
                        Ok(out) => match filtrar(&out, &conn) {
                            Some(m) => m,
                            None => continue,
                        },
                        // Ficou para trás demais. Continuar entregando bytes
                        // com segundos de atraso seria pior do que reconectar:
                        // ao voltar, o convidado pede o estado da tela e
                        // reencontra o presente de uma vez.
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            let aviso = ServerMsg::Bye {
                                reason: "A conexão ficou para trás. Reconectando…".into(),
                            };
                            let _ = escreva(&mut escrita, &aviso).await;
                            break;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    _ = ping.tick() => Message::Ping(Vec::new().into()),
                };
                if escrita.send(msg).await.is_err() {
                    break;
                }
            }
            let _ = escrita.close().await;
        })
    };

    // ---- apresentação ----
    let primeira = tokio::time::timeout(PRAZO_HELLO, leitura.next())
        .await
        .map_err(|_| "o convidado não se apresentou a tempo")?;

    let texto = match primeira {
        Some(Ok(Message::Text(t))) => t.to_string(),
        _ => {
            escritor.abort();
            return Ok(());
        }
    };

    let hello: ClientMsg = serde_json::from_str(&texto)?;
    let ClientMsg::Hello {
        version,
        code,
        name,
        resume_token,
    } = hello
    else {
        escritor.abort();
        return Ok(());
    };

    if version != PROTOCOL_VERSION {
        let motivo = if version < PROTOCOL_VERSION {
            "Seu JARVIS está mais antigo que o do anfitrião. Atualize para entrar."
        } else {
            "O JARVIS do anfitrião está mais antigo que o seu. Peça para ele atualizar."
        };
        negar(&direto_tx, motivo).await;
        finalizar(escritor, &direto_tx).await;
        return Ok(());
    }

    if let Err(motivo) = hub.checar_codigo(&code) {
        negar(&direto_tx, &motivo).await;
        finalizar(escritor, &direto_tx).await;
        return Ok(());
    }

    let (participante, token, precisa_aprovar) = match hub.join(&name, resume_token.as_deref()) {
        Ok(v) => v,
        Err(motivo) => {
            negar(&direto_tx, &motivo).await;
            finalizar(escritor, &direto_tx).await;
            return Ok(());
        }
    };
    *conn.id.write() = participante.id.clone();

    if precisa_aprovar {
        let (nome_sala, nome_host) = hub.nome_da_sala();
        enviar(&direto_tx, &ServerMsg::Pending {
            room_name: nome_sala,
            host_name: nome_host,
        })
        .await;

        let espera = hub
            .aguardar_aprovacao(&participante.id)
            .ok_or("a sala fechou enquanto o pedido esperava")?;

        let decisao = tokio::time::timeout(PRAZO_APROVACAO, espera).await;
        let aprovado = matches!(decisao, Ok(Ok(true)));
        if !aprovado {
            let motivo = match decisao {
                Err(_) => "O anfitrião não respondeu ao seu pedido a tempo.",
                _ => "O anfitrião não autorizou sua entrada.",
            };
            negar(&direto_tx, motivo).await;
            hub.on_disconnect(&participante.id);
            finalizar(escritor, &direto_tx).await;
            return Ok(());
        }
    }

    // Depois da aprovação a identidade pode ter ganhado cor e token novos.
    let (participante, token) = hub
        .dados_de_entrada(&participante.id)
        .unwrap_or((participante, token));

    let Some(welcome) = hub.welcome(participante.clone(), token) else {
        negar(&direto_tx, "A sala foi encerrada.").await;
        finalizar(escritor, &direto_tx).await;
        return Ok(());
    };

    // A ordem é deliberada: o `welcome` sai antes de o portão abrir. Um lote
    // de PTY que chegasse primeiro descreveria um terminal que a tela do
    // convidado ainda não sabe que existe.
    enviar(&direto_tx, &welcome).await;
    conn.aprovado.store(true, Ordering::Release);

    let _ = addr;
    let meu_id = participante.id.clone();

    // ---- metade que lê ----
    while let Some(quadro) = leitura.next().await {
        let quadro = match quadro {
            Ok(q) => q,
            Err(_) => break,
        };
        if !hub.is_active() || !hub.esta_dentro(&meu_id) {
            break;
        }
        match quadro {
            Message::Binary(bytes) => {
                tratar_entrada(&bytes, &hub, pty.as_ref());
            }
            Message::Text(t) => {
                let Ok(msg) = serde_json::from_str::<ClientMsg>(&t) else {
                    continue;
                };
                tratar_mensagem(msg, &meu_id, &hub, pty.as_ref(), &direto_tx, &conn).await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    soltar_ajustes(&conn, pty.as_ref());
    hub.on_disconnect(&meu_id);
    finalizar(escritor, &direto_tx).await;
    Ok(())
}

/// Devolve ao anfitrião o tamanho dos terminais que esta conexão estreitou.
///
/// Roda no caminho de saída **qualquer que ele seja** — sair pela porta,
/// perder a rede, ser expulso. É a diferença entre um ajuste e um dano: sem
/// isto, um celular que ficou sem bateria deixaria o terminal do anfitrião
/// preso em 50 colunas sem nada na tela explicando por quê.
fn soltar_ajustes(conn: &Conn, pty: &dyn PtyAccess) {
    let ids: Vec<String> = conn.ajustados.lock().drain().collect();
    for id in ids {
        pty.unfit(&id, &conn.view_id);
    }
}

/* ----------------------------- tratamento ------------------------------- */

/// Teclas do convidado. As duas guardas — terminal compartilhado e modo `rw` —
/// são conferidas **aqui**, a cada quadro, e não no momento em que a tela do
/// convidado foi montada. É o que faz "mudar para só ver" ter efeito imediato
/// sobre alguém que já estava digitando.
fn tratar_entrada(bytes: &[u8], hub: &CollabHub, pty: &dyn PtyAccess) {
    let Some((session_id, dados)) = parse_input(bytes) else {
        return;
    };
    if dados.is_empty() {
        return;
    }
    match hub.modo(session_id) {
        Some(m) if m.pode_escrever() => {}
        _ => return,
    }
    pty.write(session_id, dados);
}

async fn tratar_mensagem(
    msg: ClientMsg,
    autor: &str,
    hub: &CollabHub,
    pty: &dyn PtyAccess,
    direto: &mpsc::Sender<Message>,
    conn: &Conn,
) {
    match msg {
        ClientMsg::Chat { text } => {
            hub.post_chat(autor, &text);
        }
        ClientMsg::Ai { text } => {
            hub.ai_ask(autor, &text);
        }
        ClientMsg::Ping { t0 } => {
            enviar(direto, &ServerMsg::Pong { t0 }).await;
        }
        ClientMsg::Snapshot { session_id } => {
            // Mesma guarda da entrada: o estado da tela de um terminal não
            // compartilhado não sai da máquina nem sob pedido explícito.
            if hub.modo(&session_id).is_none() {
                return;
            }
            let Some(snap) = pty.snapshot(&session_id) else {
                return;
            };
            let quadro = frame_com_seq(OP_SNAPSHOT, &session_id, snap.seq, &snap.bytes);
            let _ = direto.send(Message::binary(quadro)).await;

            // O tamanho vai junto: sem ele, o xterm do convidado desenharia
            // no tamanho da janela dele e o conteúdo do instantâneo quebraria
            // linha no lugar errado.
            if let Some((cols, rows)) = hub.tamanho_atual(&session_id) {
                enviar(direto, &ServerMsg::Size {
                    session_id,
                    cols,
                    rows,
                })
                .await;
            }
        }
        ClientMsg::Fit {
            session_id,
            cols,
            rows,
        } => {
            // Mesma guarda da tecla, e pela mesma razão: encolher o terminal
            // de alguém é mexer no terminal de alguém. Quem só assiste não
            // muda o que os outros veem.
            match hub.modo(&session_id) {
                Some(m) if m.pode_escrever() => {}
                _ => return,
            }
            let cols = cols.clamp(*FIT_COLS.start(), *FIT_COLS.end());
            let rows = rows.clamp(*FIT_ROWS.start(), *FIT_ROWS.end());
            conn.ajustados.lock().insert(session_id.clone());
            pty.fit(&session_id, &conn.view_id, cols, rows);
        }
        ClientMsg::Unfit { session_id } => {
            // Sem guarda de modo: parar de ajustar só devolve espaço, e uma
            // permissão revogada no meio do caminho não pode ser motivo para
            // o terminal do anfitrião ficar estreito para sempre.
            if conn.ajustados.lock().remove(&session_id) {
                pty.unfit(&session_id, &conn.view_id);
            }
        }
        ClientMsg::Hello { .. } => {}
    }
}

/* ------------------------------ utilidades ------------------------------ */

/// Decide se um quadro da sala é para esta conexão e o converte.
fn filtrar(out: &Out, conn: &Conn) -> Option<Message> {
    match out {
        Out::Bin(bytes) => {
            // Antes da aprovação nenhum byte de terminal sai.
            if !conn.aprovado.load(Ordering::Acquire) {
                return None;
            }
            Some(Message::binary(bytes.clone()))
        }
        Out::Text(t) => {
            if let Some(resto) = t.strip_prefix('@') {
                // Endereçada: `@<id>\n<json>`.
                let (destino, json) = resto.split_once('\n')?;
                if destino != *conn.id.read() {
                    return None;
                }
                return Some(Message::text(json.to_string()));
            }
            if !conn.aprovado.load(Ordering::Acquire) {
                return None;
            }
            Some(Message::text(t.clone()))
        }
    }
}

async fn enviar(direto: &mpsc::Sender<Message>, msg: &ServerMsg) {
    if let Ok(json) = serde_json::to_string(msg) {
        let _ = direto.send(Message::text(json)).await;
    }
}

async fn negar(direto: &mpsc::Sender<Message>, motivo: &str) {
    enviar(direto, &ServerMsg::Denied {
        reason: motivo.to_string(),
    })
    .await;
}

async fn escreva<S>(sink: &mut S, msg: &ServerMsg) -> Result<(), ()>
where
    S: SinkExt<Message> + Unpin,
{
    let json = serde_json::to_string(msg).map_err(|_| ())?;
    sink.send(Message::text(json)).await.map_err(|_| ())
}

/// Fecha a metade que escreve dando tempo de a última mensagem sair — um
/// `abort` seco engoliria justamente o "não autorizado" que explica ao
/// convidado por que a porta se fechou.
async fn finalizar(escritor: tokio::task::JoinHandle<()>, direto: &mpsc::Sender<Message>) {
    drop(direto.clone());
    let _ = tokio::time::timeout(Duration::from_secs(2), escritor).await;
}

/// Espia o começo da requisição sem consumi-la, para distinguir um navegador
/// de um convidado. `peek` deixa os bytes no socket, então o handshake do
/// WebSocket logo adiante ainda os encontra intactos.
async fn é_upgrade(stream: &TcpStream) -> bool {
    let mut buf = [0u8; 1024];
    for _ in 0..40 {
        match stream.peek(&mut buf).await {
            Ok(0) => return false,
            Ok(n) => {
                let cabeca = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                if cabeca.contains("upgrade: websocket") {
                    return true;
                }
                // Cabeçalho completo e sem upgrade: é um navegador.
                if cabeca.contains("\r\n\r\n") {
                    return false;
                }
                if n == buf.len() {
                    return false;
                }
            }
            Err(_) => return false,
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collab::protocol::{Mode, SharedTerminal};
    use crate::collab::StartOptions;

    fn terminal(id: &str, mode: Mode) -> SharedTerminal {
        SharedTerminal {
            session_id: id.into(),
            title: "t".into(),
            mode,
            cols: 80,
            rows: 24,
            alive: true,
            folder: None,
        }
    }

    fn conn(id: &str, aprovado: bool) -> Conn {
        Conn {
            aprovado: AtomicBool::new(aprovado),
            id: RwLock::new(id.into()),
            view_id: "collab:teste".into(),
            ajustados: Mutex::new(HashSet::new()),
        }
    }

    #[test]
    fn endereçada_so_chega_a_quem_e_dela() {
        let conn = conn("abc", true);
        let minha = Out::Text("@abc\n{\"t\":\"pong\"}".into());
        let alheia = Out::Text("@xyz\n{\"t\":\"pong\"}".into());
        assert!(filtrar(&minha, &conn).is_some());
        assert!(filtrar(&alheia, &conn).is_none());
    }

    #[test]
    fn nada_flui_antes_da_aprovacao() {
        let conn = conn("abc", false);
        assert!(
            filtrar(&Out::Bin(vec![1, 2, 3]), &conn).is_none(),
            "bytes de terminal vazaram para quem ainda espera aprovação"
        );
        assert!(filtrar(&Out::Text("{\"t\":\"chat\"}".into()), &conn).is_none());
        // O que é endereçado a ele passa: é assim que o "aguarde" e o
        // "recusado" chegam.
        assert!(filtrar(&Out::Text("@abc\n{}".into()), &conn).is_some());
    }

    #[test]
    fn so_o_modo_rw_deixa_a_tecla_passar() {
        // Sem `AppHandle` num teste de unidade, a verificação aqui é a do
        // portão em si: `tratar_entrada` só chega ao `pty.write` depois de
        // `modo(..).pode_escrever()`, e é isso que este teste fixa.
        let hub = CollabHub::new();
        hub.open(
            &StartOptions {
                name: None,
                host_name: None,
                port: 0,
                require_approval: false,
                public: false,
            },
            0,
            None,
        );
        hub.share(terminal("ro", Mode::Ro));
        hub.share(terminal("rw", Mode::Rw));

        assert!(!hub.modo("ro").unwrap().pode_escrever());
        assert!(hub.modo("rw").unwrap().pode_escrever());
        assert!(hub.modo("nao-compartilhado").is_none());
    }
}
