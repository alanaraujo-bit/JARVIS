//! Trabalho compartilhado de ponta a ponta: sala real, socket real, protocolo
//! real.
//!
//! Os testes de unidade do hub provam as decisões (quem entra, o que é
//! visível, quem pode escrever). O que eles não alcançam é a distância entre a
//! decisão e o byte que sai pela rede — o handshake, a ordem em que as
//! mensagens chegam, o filtro por conexão, o quadro binário montado de um lado
//! e lido do outro. É onde mora a classe de bug que só aparece com duas
//! máquinas na mesa.
//!
//! Por isso aqui nada é simulado do lado do transporte: sobe-se um
//! `TcpListener` de verdade, o convidado é um cliente WebSocket de verdade e
//! ele fala exatamente o que o `src/lib/collabProtocol.ts` fala. O único
//! substituto é o motor de PTY, e por um motivo específico: os testes
//! precisam **verificar que teclas não autorizadas nunca chegaram nele**, e um
//! espião registra isso de um jeito que um shell de verdade não registra.
//!
//! Regra da suíte (a mesma de `pty_engine.rs`): cada teste tem que falhar se a
//! linha que ele protege for removida.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use jarvis_lib::collab::protocol::{
    Mode, SharedTerminal, OP_DATA, OP_INPUT, OP_SNAPSHOT, PROTOCOL_VERSION,
};
use jarvis_lib::collab::server::{self, PtyAccess};
use jarvis_lib::collab::{CollabHub, StartOptions};
use jarvis_lib::protocol::Snapshot;

/// Teto de espera por uma mensagem. Generoso para não piscar em máquina de CI
/// carregada, e curto o bastante para uma falha aparecer como falha em vez de
/// travar a suíte.
const PRAZO: Duration = Duration::from_secs(5);

/* --------------------------- motor de PTY espião ------------------------- */

/// Registra tudo que o servidor tentou escrever num PTY. É o instrumento
/// central dos testes de permissão: provar que uma tecla **não** passou exige
/// alguém do outro lado dizendo que não recebeu nada.
#[derive(Default)]
struct PtyEspiao {
    escritas: Mutex<Vec<(String, Vec<u8>)>>,
    telas: Mutex<HashMap<String, Snapshot>>,
    /// Tamanhos pedidos por painel, como o motor de verdade guarda. O valor
    /// `None` marca um painel que foi removido — é o que distingue "nunca
    /// ajustou" de "ajustou e soltou", e a segunda é a que precisa acontecer
    /// quando um celular some da rede.
    ajustes: Mutex<Vec<(String, String, Option<(u16, u16)>)>>,
}

impl PtyEspiao {
    fn com_tela(&self, id: &str, bytes: &[u8], seq: u64) {
        self.telas.lock().insert(
            id.to_string(),
            Snapshot {
                bytes: bytes.to_vec(),
                seq,
            },
        );
    }

    fn escritas_de(&self, id: &str) -> Vec<u8> {
        self.escritas
            .lock()
            .iter()
            .filter(|(s, _)| s == id)
            .flat_map(|(_, b)| b.clone())
            .collect()
    }

    /// O que aconteceu com o tamanho de um terminal, na ordem. `Some` é um
    /// painel entrando na conta; `None` é ele saindo.
    fn ajustes_de(&self, id: &str) -> Vec<Option<(u16, u16)>> {
        self.ajustes
            .lock()
            .iter()
            .filter(|(s, _, _)| s == id)
            .map(|(_, _, v)| *v)
            .collect()
    }

    async fn aguarda_ajustes(&self, id: &str, esperado: Vec<Option<(u16, u16)>>) {
        let limite = tokio::time::Instant::now() + PRAZO;
        while tokio::time::Instant::now() < limite {
            if self.ajustes_de(id) == esperado {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "o terminal {id} recebeu os ajustes {:?}, esperava {esperado:?}",
            self.ajustes_de(id)
        );
    }

    /// Espera até o servidor ter escrito `esperado` no PTY, ou desiste. As
    /// teclas atravessam socket e uma tarefa antes de chegar aqui; comparar
    /// imediatamente testaria o escalonador, não o código.
    async fn aguarda_escrita(&self, id: &str, esperado: &[u8]) {
        let limite = tokio::time::Instant::now() + PRAZO;
        while tokio::time::Instant::now() < limite {
            if self.escritas_de(id) == esperado {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "o PTY {id} recebeu {:?}, esperava {:?}",
            String::from_utf8_lossy(&self.escritas_de(id)),
            String::from_utf8_lossy(esperado)
        );
    }
}

impl PtyAccess for PtyEspiao {
    fn write(&self, session_id: &str, bytes: &[u8]) {
        self.escritas
            .lock()
            .push((session_id.to_string(), bytes.to_vec()));
    }

    fn snapshot(&self, session_id: &str) -> Option<Snapshot> {
        self.telas.lock().get(session_id).cloned()
    }

    fn fit(&self, session_id: &str, view_id: &str, cols: u16, rows: u16) {
        self.ajustes.lock().push((
            session_id.to_string(),
            view_id.to_string(),
            Some((cols, rows)),
        ));
    }

    fn unfit(&self, session_id: &str, view_id: &str) {
        self.ajustes
            .lock()
            .push((session_id.to_string(), view_id.to_string(), None));
    }
}

/* --------------------------------- sala ---------------------------------- */

struct Sala {
    hub: Arc<CollabHub>,
    pty: Arc<PtyEspiao>,
    porta: u16,
    code: String,
}

impl Sala {
    async fn abrir(aprovacao: bool) -> Self {
        let hub = Arc::new(CollabHub::new());
        let pty = Arc::new(PtyEspiao::default());

        let (listener, porta) = server::bind(0).await.expect("porta livre");
        let code = hub.open(
            &StartOptions {
                name: Some("Sala de teste".into()),
                host_name: Some("Anfitriã".into()),
                port: 0,
                require_approval: aprovacao,
                public: false,
            },
            porta,
            None,
        );

        let hub_srv = Arc::clone(&hub);
        let pty_srv: Arc<dyn PtyAccess> = Arc::clone(&pty) as Arc<dyn PtyAccess>;
        tokio::spawn(async move {
            server::serve(listener, hub_srv, pty_srv).await;
        });

        Self {
            hub,
            pty,
            porta,
            code,
        }
    }

    fn compartilha(&self, id: &str, mode: Mode) {
        self.hub.share(SharedTerminal {
            session_id: id.into(),
            title: format!("terminal {id}"),
            mode,
            cols: 80,
            rows: 24,
            alive: true,
            folder: Some("JARVIS".into()),
        });
    }
}

impl Drop for Sala {
    fn drop(&mut self) {
        // Encerra o laço de aceitação: sem isto cada teste deixaria uma tarefa
        // viva segurando uma porta pelo resto da suíte.
        self.hub.close("fim do teste");
    }
}

/* ------------------------------- convidado ------------------------------- */

struct Convidado {
    ws: WebSocketStream<TcpStream>,
}

impl Convidado {
    async fn conecta(porta: u16) -> Self {
        let tcp = TcpStream::connect(("127.0.0.1", porta))
            .await
            .expect("conectar na sala");
        let (ws, _) = tokio_tungstenite::client_async(format!("ws://127.0.0.1:{porta}/"), tcp)
            .await
            .expect("handshake do websocket");
        Self { ws }
    }

    async fn envia(&mut self, v: Value) {
        self.ws
            .send(Message::text(v.to_string()))
            .await
            .expect("enviar ao anfitrião");
    }

    async fn hello(&mut self, code: &str, nome: &str) {
        self.envia(json!({
            "t": "hello",
            "version": PROTOCOL_VERSION,
            "code": code,
            "name": nome,
        }))
        .await;
    }

    /// Teclas, no mesmo quadro binário que o cliente TypeScript monta.
    async fn digita(&mut self, session_id: &str, teclas: &[u8]) {
        let mut quadro = vec![OP_INPUT, session_id.len() as u8];
        quadro.extend_from_slice(session_id.as_bytes());
        quadro.extend_from_slice(teclas);
        self.ws
            .send(Message::binary(quadro))
            .await
            .expect("enviar teclas");
    }

    /// Próxima mensagem que não seja controle de transporte. Os `ping` do
    /// servidor não fazem parte do protocolo da sala e não deveriam aparecer
    /// nas asserções.
    async fn proxima(&mut self) -> Message {
        let limite = tokio::time::Instant::now() + PRAZO;
        loop {
            let restante = limite.saturating_duration_since(tokio::time::Instant::now());
            let msg = tokio::time::timeout(restante, self.ws.next())
                .await
                .expect("o anfitrião não respondeu a tempo")
                .expect("a conexão fechou sem mensagem")
                .expect("quadro inválido");
            match msg {
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
                outra => return outra,
            }
        }
    }

    /// Próxima mensagem de texto, já como JSON.
    async fn json(&mut self) -> Value {
        match self.proxima().await {
            Message::Text(t) => serde_json::from_str(&t).expect("json do anfitrião"),
            Message::Close(c) => panic!("a sala fechou a conexão: {c:?}"),
            Message::Binary(b) => panic!("esperava texto, veio quadro binário de {} bytes", b.len()),
            outra => panic!("esperava texto, veio {outra:?}"),
        }
    }

    /// Espera a próxima mensagem de texto de um tipo específico, descartando
    /// as de sala que chegarem no meio (`participants`, `terminals`) — elas
    /// dependem de quem mais está conectado no momento e não são o assunto de
    /// todo teste.
    async fn json_do_tipo(&mut self, t: &str) -> Value {
        let limite = tokio::time::Instant::now() + PRAZO;
        loop {
            let v = self.json().await;
            if v["t"] == t {
                return v;
            }
            assert!(
                tokio::time::Instant::now() < limite,
                "não veio nenhuma mensagem \"{t}\""
            );
        }
    }

    async fn entra(&mut self, code: &str, nome: &str) -> Value {
        self.hello(code, nome).await;
        self.json_do_tipo("welcome").await
    }

    /// Espera o anúncio de participantes que já tem `quantos` pessoas.
    ///
    /// Os anúncios anteriores não são erro: cada entrada gera o seu, e o da
    /// própria conexão pode chegar depois do `welcome`. Fixar "o próximo
    /// anúncio" como se fosse o de outra pessoa é o que torna um teste destes
    /// intermitente.
    async fn participantes(&mut self, quantos: usize) -> Vec<String> {
        let limite = tokio::time::Instant::now() + PRAZO;
        loop {
            let v = self.json_do_tipo("participants").await;
            let nomes: Vec<String> = v["participants"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["name"].as_str().unwrap().to_string())
                .collect();
            if nomes.len() == quantos {
                return nomes;
            }
            assert!(
                tokio::time::Instant::now() < limite,
                "a sala nunca anunciou {quantos} participantes; parou em {nomes:?}"
            );
        }
    }

    /// Próximo quadro binário.
    ///
    /// Mensagens de texto da sala são puladas: as duas famílias de quadro
    /// viajam pelo mesmo socket e o protocolo não promete ordem entre elas —
    /// só dentro de cada uma. O que os testes de vazamento verificam é a
    /// ordem **entre quadros binários**, e essa continua valendo.
    async fn binario(&mut self) -> Quadro {
        let limite = tokio::time::Instant::now() + PRAZO;
        loop {
            match self.proxima().await {
                Message::Binary(b) => return le_quadro(&b),
                Message::Text(_) => assert!(
                    tokio::time::Instant::now() < limite,
                    "nenhum quadro binário chegou"
                ),
                Message::Close(c) => panic!("a sala fechou a conexão: {c:?}"),
                outra => panic!("esperava quadro binário, veio {outra:?}"),
            }
        }
    }
}

/* ------------------------------- quadros --------------------------------- */

#[derive(Debug, PartialEq)]
struct Quadro {
    op: u8,
    session_id: String,
    seq: u64,
    dados: Vec<u8>,
}

/// Lê `[op][tamanho do id][id][seq de 8 bytes][conteúdo]` — a contraparte do
/// `decodeFrame` do cliente. Escrito à mão aqui de propósito: se o teste
/// reusasse o decodificador do produto, uma mudança errada no formato passaria
/// nos dois lados ao mesmo tempo e o teste não veria nada.
fn le_quadro(b: &[u8]) -> Quadro {
    assert!(b.len() >= 10, "quadro curto demais: {} bytes", b.len());
    let id_len = b[1] as usize;
    let fim_id = 2 + id_len;
    Quadro {
        op: b[0],
        session_id: String::from_utf8(b[2..fim_id].to_vec()).expect("id em utf-8"),
        seq: u64::from_be_bytes(b[fim_id..fim_id + 8].try_into().unwrap()),
        dados: b[fim_id + 8..].to_vec(),
    }
}

/* --------------------------------- testes -------------------------------- */

#[tokio::test(flavor = "multi_thread")]
async fn convidado_entra_e_ve_a_saida_do_terminal_compartilhado() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("s1", Mode::Ro);

    let mut c = Convidado::conecta(sala.porta).await;
    let welcome = c.entra(&sala.code, "Primo").await;

    assert_eq!(welcome["room"]["name"], "Sala de teste");
    assert_eq!(welcome["room"]["hostName"], "Anfitriã");
    assert_eq!(welcome["you"]["name"], "Primo");
    assert_eq!(welcome["you"]["role"], "guest");
    assert_eq!(welcome["terminals"][0]["sessionId"], "s1");
    assert_eq!(welcome["terminals"][0]["mode"], "ro");
    assert_eq!(welcome["terminals"][0]["folder"], "JARVIS");
    assert!(
        welcome["resumeToken"].as_str().is_some_and(|t| !t.is_empty()),
        "sem token de reentrada, cada queda de Wi-Fi custaria uma aprovação nova"
    );

    sala.hub.on_pty_data("s1", b"ola do shell", 7);
    let q = c.binario().await;
    assert_eq!(
        q,
        Quadro {
            op: OP_DATA,
            session_id: "s1".into(),
            seq: 7,
            dados: b"ola do shell".to_vec(),
        }
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_nao_compartilhado_nao_atravessa_a_rede() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("visivel", Mode::Ro);

    let mut c = Convidado::conecta(sala.porta).await;
    let welcome = c.entra(&sala.code, "Primo").await;
    assert_eq!(
        welcome["terminals"].as_array().unwrap().len(),
        1,
        "o terminal privado apareceu na lista do convidado"
    );

    // O privado sai primeiro. Como a ordem dentro de uma conexão é FIFO, se
    // ele vazasse chegaria antes do outro — e o próximo quadro não seria o do
    // terminal compartilhado.
    sala.hub.on_pty_data("privado", b"senha: hunter2", 1);
    sala.hub.on_pty_data("visivel", b"ok", 2);

    let q = c.binario().await;
    assert_eq!(q.session_id, "visivel", "vazou a saída de um terminal privado");
    assert_eq!(q.dados, b"ok");
}

#[tokio::test(flavor = "multi_thread")]
async fn tecla_de_convidado_so_entra_no_terminal_em_modo_rw() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("so-olhando", Mode::Ro);
    sala.compartilha("pode-digitar", Mode::Rw);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "Primo").await;

    c.digita("so-olhando", b"rm -rf /\r").await;
    c.digita("nao-compartilhado", b"whoami\r").await;
    c.digita("pode-digitar", b"ls\r").await;

    // A última tecla é a barreira: quando ela aparece, as duas anteriores já
    // foram processadas, e o que não estiver registrado nunca vai estar.
    sala.pty.aguarda_escrita("pode-digitar", b"ls\r").await;
    assert!(
        sala.pty.escritas_de("so-olhando").is_empty(),
        "convidado escreveu num terminal marcado como só leitura"
    );
    assert!(
        sala.pty.escritas_de("nao-compartilhado").is_empty(),
        "convidado escreveu num terminal que nunca foi compartilhado"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn tirar_a_permissao_cala_quem_ja_estava_digitando() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("t", Mode::Rw);
    sala.compartilha("barreira", Mode::Rw);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "Primo").await;

    c.digita("t", b"antes").await;
    sala.pty.aguarda_escrita("t", b"antes").await;

    // O anfitrião muda de ideia com a conexão já aberta e o convidado já
    // digitando. O corte tem que valer para o próximo quadro, não para a
    // próxima conexão.
    sala.compartilha("t", Mode::Ro);

    c.digita("t", b"depois").await;
    c.digita("barreira", b"x").await;
    sala.pty.aguarda_escrita("barreira", b"x").await;

    assert_eq!(
        sala.pty.escritas_de("t"),
        b"antes",
        "a tecla passou depois de o terminal virar só leitura"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn codigo_errado_nao_abre_a_porta() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("s1", Mode::Rw);

    let mut c = Convidado::conecta(sala.porta).await;
    c.hello("ZZZZ-ZZZZ", "Estranho").await;

    let v = c.json().await;
    assert_eq!(v["t"], "denied");
    assert_eq!(v["reason"], "Código incorreto.");
    assert!(
        sala.hub.host_state().room.unwrap().participants.len() == 1,
        "quem errou o código entrou na lista de participantes"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn versao_incompativel_diz_qual_dos_dois_deve_atualizar() {
    let sala = Sala::abrir(false).await;

    let mut antigo = Convidado::conecta(sala.porta).await;
    antigo
        .envia(json!({
            "t": "hello",
            "version": PROTOCOL_VERSION - 1,
            "code": sala.code,
            "name": "Antigo",
        }))
        .await;
    let v = antigo.json().await;
    assert_eq!(v["t"], "denied");
    assert!(
        v["reason"].as_str().unwrap().contains("Atualize"),
        "o convidado desatualizado deveria ser mandado atualizar: {}",
        v["reason"]
    );

    let mut novo = Convidado::conecta(sala.porta).await;
    novo.envia(json!({
        "t": "hello",
        "version": PROTOCOL_VERSION + 1,
        "code": sala.code,
        "name": "Novo",
    }))
    .await;
    let v = novo.json().await;
    assert_eq!(v["t"], "denied");
    assert!(
        v["reason"].as_str().unwrap().contains("anfitrião"),
        "com o anfitrião atrasado, quem atualiza é ele: {}",
        v["reason"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn quem_espera_aprovacao_nao_ve_nada_ate_o_sim() {
    let sala = Sala::abrir(true).await;
    sala.compartilha("s1", Mode::Ro);

    let mut c = Convidado::conecta(sala.porta).await;
    c.hello(&sala.code, "Primo").await;

    let pendente = c.json().await;
    assert_eq!(pendente["t"], "pending");
    assert_eq!(pendente["roomName"], "Sala de teste");

    // Saída de terminal enquanto o pedido está na fila: não pode chegar.
    sala.hub.on_pty_data("s1", b"segredo antes do sim", 1);

    let id = {
        let sala_estado = sala.hub.host_state().room.unwrap();
        assert_eq!(sala_estado.pending.len(), 1);
        assert_eq!(sala_estado.pending[0].name, "Primo");
        sala_estado.pending[0].id.clone()
    };
    sala.hub.decidir(&id, true);

    // O `welcome` chega, e nenhum quadro binário antes dele: `json_do_tipo`
    // estoura se o que vier for a saída de terminal que foi emitida enquanto
    // o pedido esperava na porta.
    let welcome = c.json_do_tipo("welcome").await;
    assert_eq!(welcome["you"]["name"], "Primo");

    sala.hub.on_pty_data("s1", b"depois do sim", 2);
    let q = c.binario().await;
    assert_eq!(q.dados, b"depois do sim");
}

#[tokio::test(flavor = "multi_thread")]
async fn recusa_do_anfitriao_chega_explicada() {
    let sala = Sala::abrir(true).await;

    let mut c = Convidado::conecta(sala.porta).await;
    c.hello(&sala.code, "Estranho").await;
    assert_eq!(c.json().await["t"], "pending");

    let id = sala.hub.host_state().room.unwrap().pending[0].id.clone();
    sala.hub.decidir(&id, false);

    let v = c.json().await;
    assert_eq!(v["t"], "denied");
    assert_eq!(v["reason"], "O anfitrião não autorizou sua entrada.");
    assert!(sala.hub.host_state().room.unwrap().pending.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn duas_pessoas_na_sala_se_veem_e_conversam() {
    let sala = Sala::abrir(false).await;

    let mut ana = Convidado::conecta(sala.porta).await;
    ana.entra(&sala.code, "Ana").await;

    let mut bruno = Convidado::conecta(sala.porta).await;
    let welcome_bruno = bruno.entra(&sala.code, "Bruno").await;

    // Quem chega depois já nasce vendo quem estava lá — anfitrião incluído.
    let nomes: Vec<&str> = welcome_bruno["participants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(nomes, vec!["Anfitriã", "Ana", "Bruno"]);

    // E quem já estava é avisado da chegada.
    assert_eq!(
        ana.participantes(3).await,
        vec!["Anfitriã", "Ana", "Bruno"],
        "a chegada do Bruno não apareceu na tela da Ana"
    );

    bruno
        .envia(json!({ "t": "chat", "text": "  cheguei  " }))
        .await;

    let msg = ana.json_do_tipo("chat").await;
    assert_eq!(msg["message"]["authorName"], "Bruno");
    assert_eq!(
        msg["message"]["text"], "cheguei",
        "o espaço em volta da mensagem deveria ter sido aparado"
    );
    assert_eq!(
        msg["message"]["authorColor"], welcome_bruno["you"]["color"],
        "a cor no balão tem que ser a mesma da lista de participantes"
    );

    // E o anfitrião guarda a conversa para quem entrar depois.
    let historico = sala.hub.host_state().room.unwrap().chat;
    assert_eq!(historico.len(), 1);
    assert_eq!(historico[0].text, "cheguei");
}

#[tokio::test(flavor = "multi_thread")]
async fn abrir_um_terminal_traz_a_tela_como_ela_esta_e_no_tamanho_certo() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("s1", Mode::Ro);
    sala.pty.com_tela("s1", b"$ ls\nREADME.md\n", 41);
    sala.pty.com_tela("privado", b"nao deveria sair", 9);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "Primo").await;

    c.envia(json!({ "t": "snapshot", "sessionId": "s1" })).await;
    let q = c.binario().await;
    assert_eq!(q.op, OP_SNAPSHOT);
    assert_eq!(q.session_id, "s1");
    assert_eq!(
        q.seq, 41,
        "sem a posição no fluxo, o convidado não sabe quais lotes já estão na tela"
    );
    assert_eq!(q.dados, b"$ ls\nREADME.md\n");

    // O tamanho vem logo atrás: desenhar o instantâneo no tamanho da janela do
    // convidado quebraria as linhas no lugar errado.
    let tamanho = c.json_do_tipo("size").await;
    assert_eq!(tamanho["sessionId"], "s1");
    assert_eq!(tamanho["cols"], 80);
    assert_eq!(tamanho["rows"], 24);

    // Pedir a tela de um terminal privado não é um jeito alternativo de vê-la.
    c.envia(json!({ "t": "snapshot", "sessionId": "privado" }))
        .await;
    c.envia(json!({ "t": "ping", "t0": 99 })).await;
    // O `pong` foi pedido depois e chega primeiro, porque o instantâneo do
    // terminal privado não chega nunca. Um quadro binário aqui estoura o
    // `json_do_tipo` — é essa a asserção.
    assert_eq!(c.json_do_tipo("pong").await["t0"], 99);
}

#[tokio::test(flavor = "multi_thread")]
async fn redimensionar_o_terminal_do_anfitriao_chega_ao_convidado() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("s1", Mode::Ro);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "Primo").await;

    sala.hub.on_resize("s1", 120, 40);
    let v = c.json_do_tipo("size").await;
    assert_eq!(v["sessionId"], "s1");
    assert_eq!(v["cols"], 120);
    assert_eq!(v["rows"], 40);
}

#[tokio::test(flavor = "multi_thread")]
async fn processo_que_morre_e_anunciado_com_o_codigo_de_saida() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("s1", Mode::Rw);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "Primo").await;

    sala.hub.on_pty_exit("s1", 130);
    let v = c.json_do_tipo("exit").await;
    assert_eq!(v["sessionId"], "s1");
    assert_eq!(v["exitCode"], 130);
}

#[tokio::test(flavor = "multi_thread")]
async fn quem_e_removido_sabe_por_que_e_perde_a_conexao() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("s1", Mode::Rw);

    let mut ana = Convidado::conecta(sala.porta).await;
    let welcome = ana.entra(&sala.code, "Ana").await;
    let id = welcome["you"]["id"].as_str().unwrap().to_string();

    let mut bruno = Convidado::conecta(sala.porta).await;
    bruno.entra(&sala.code, "Bruno").await;

    sala.hub.kick(&id);

    let v = ana.json_do_tipo("denied").await;
    assert_eq!(v["reason"], "O anfitrião removeu você da sala.");

    // A expulsão vale para o resto da sala, não só para a tela de quem saiu.
    let restantes = sala.hub.host_state().room.unwrap().participants;
    assert!(
        !restantes.iter().any(|p| p.id == id),
        "o removido continuou na lista de participantes"
    );

    // E quem ficou continua funcionando: expulsar um não derruba o outro.
    sala.hub.on_pty_data("s1", b"ainda aqui", 3);
    let q = bruno.binario().await;
    assert_eq!(q.dados, b"ainda aqui");
}

#[tokio::test(flavor = "multi_thread")]
async fn teclas_do_removido_nao_valem_mais() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("t", Mode::Rw);

    let mut c = Convidado::conecta(sala.porta).await;
    let welcome = c.entra(&sala.code, "Primo").await;
    let id = welcome["you"]["id"].as_str().unwrap().to_string();

    c.digita("t", b"antes").await;
    sala.pty.aguarda_escrita("t", b"antes").await;

    sala.hub.kick(&id);
    // A conexão pode levar um instante para notar; insistir é justamente o que
    // um cliente hostil faria.
    for _ in 0..20 {
        c.digita("t", b"depois").await;
        tokio::time::sleep(Duration::from_millis(25)).await;
        if sala.pty.escritas_de("t") != b"antes" {
            break;
        }
    }
    assert_eq!(
        sala.pty.escritas_de("t"),
        b"antes",
        "quem foi removido continuou digitando no terminal do anfitrião"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn latencia_tem_resposta_com_a_marca_de_quem_perguntou() {
    let sala = Sala::abrir(false).await;

    let mut ana = Convidado::conecta(sala.porta).await;
    ana.entra(&sala.code, "Ana").await;
    let mut bruno = Convidado::conecta(sala.porta).await;
    bruno.entra(&sala.code, "Bruno").await;

    ana.envia(json!({ "t": "ping", "t0": 1234u64 })).await;
    let v = ana.json_do_tipo("pong").await;
    assert_eq!(
        v["t0"], 1234u64,
        "o pong tem que devolver o instante do pedido, senão não dá para medir nada"
    );

    // O pong é endereçado: a resposta da Ana não pode aparecer na tela do
    // Bruno como se ele tivesse perguntado.
    bruno.envia(json!({ "t": "chat", "text": "eco" })).await;
    let dele = bruno.json_do_tipo("chat").await;
    assert_eq!(dele["message"]["text"], "eco");
}

#[tokio::test(flavor = "multi_thread")]
async fn fechar_a_sala_avisa_antes_de_derrubar() {
    let sala = Sala::abrir(false).await;

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "Primo").await;

    sala.hub.close("O anfitrião encerrou a sala.");

    let v = c.json_do_tipo("bye").await;
    assert_eq!(
        v["reason"], "O anfitrião encerrou a sala.",
        "sem o motivo, a tela do convidado só saberia dizer 'conexão perdida'"
    );
}

/* --------------------------- o app do celular ---------------------------- */

/// Faz um pedido HTTP na mesma porta da sala e devolve a resposta crua.
async fn http(porta: u16, pedido: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut tcp = TcpStream::connect(("127.0.0.1", porta))
        .await
        .expect("conectar");
    tcp.write_all(pedido.as_bytes())
        .await
        .expect("enviar requisição");

    let mut resposta = Vec::new();
    tokio::time::timeout(PRAZO, tcp.read_to_end(&mut resposta))
        .await
        .expect("o navegador ficou sem resposta")
        .expect("ler resposta");
    String::from_utf8_lossy(&resposta).into_owned()
}

fn cabecalho<'a>(resposta: &'a str, nome: &str) -> Option<&'a str> {
    resposta
        .split("\r\n\r\n")
        .next()?
        .split("\r\n")
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.eq_ignore_ascii_case(nome))
        .map(|(_, v)| v.trim())
}

#[tokio::test(flavor = "multi_thread")]
async fn abrir_o_endereco_no_navegador_entrega_o_app_do_celular() {
    let sala = Sala::abrir(false).await;

    let r = http(
        sala.porta,
        "GET / HTTP/1.1\r\nHost: localhost\r\nAccept: text/html\r\n\r\n",
    )
    .await;

    assert!(r.starts_with("HTTP/1.1 200"), "resposta: {r}");
    assert!(
        cabecalho(&r, "content-type").unwrap().contains("text/html"),
        "sem o tipo de conteúdo o navegador mostraria o HTML como texto cru"
    );
    // A página tem que poder abrir `wss://` de volta para a própria origem —
    // é o único motivo de ela existir. Uma política que esqueça disso
    // entregaria um app bonito que nunca conecta.
    assert!(
        cabecalho(&r, "content-security-policy")
            .unwrap()
            .contains("connect-src 'self' ws: wss:"),
        "a política de segurança bloquearia o WebSocket: {r}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_segunda_visita_nao_baixa_o_app_de_novo() {
    let sala = Sala::abrir(false).await;

    let primeira = http(sala.porta, "GET /app.js HTTP/1.1\r\nHost: x\r\n\r\n").await;
    let etag = cabecalho(&primeira, "etag").expect("sem ETag não há revalidação");

    let segunda = http(
        sala.porta,
        &format!("GET /app.js HTTP/1.1\r\nHost: x\r\nIf-None-Match: {etag}\r\n\r\n"),
    )
    .await;

    assert!(
        segunda.starts_with("HTTP/1.1 304"),
        "o app inteiro desceu de novo numa reabertura: {segunda}"
    );
    assert!(
        segunda.ends_with("\r\n\r\n"),
        "um 304 com corpo é justamente o que ele existe para evitar"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn o_pwa_tem_o_que_o_celular_precisa_para_instalar() {
    let sala = Sala::abrir(false).await;

    for rota in ["/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png"] {
        let r = http(sala.porta, &format!("GET {rota} HTTP/1.1\r\nHost: x\r\n\r\n")).await;
        assert!(
            r.starts_with("HTTP/1.1 200"),
            "sem {rota} o celular não instala o app: {r}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_porta_da_sala_nao_serve_arquivo_nenhum_da_maquina() {
    let sala = Sala::abrir(false).await;

    // Travessia de caminho é o primeiro reflexo de quem encontra um servidor
    // de arquivos numa porta exposta à internet. Aqui não existe caminho:
    // as rotas são uma lista fechada, e o que não está nela é 404.
    for alvo in [
        "/../../../../Windows/win.ini",
        "/..%2f..%2fetc/passwd",
        "/app.js/../../Cargo.toml",
        "/index.html%00.png",
        "/src-tauri/tauri.conf.json",
    ] {
        let r = http(sala.porta, &format!("GET {alvo} HTTP/1.1\r\nHost: x\r\n\r\n")).await;
        assert!(
            r.starts_with("HTTP/1.1 404"),
            "{alvo} devolveu algo que não era 404: {r}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn o_codigo_da_sala_nao_sai_junto_com_o_app() {
    let sala = Sala::abrir(false).await;

    // Tudo isto é servido antes de qualquer autenticação — não há como ser
    // diferente, é a tela de login. Então nada aqui pode conter o segredo que
    // a tela de login pede.
    for rota in ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/sw.js"] {
        let r = http(sala.porta, &format!("GET {rota} HTTP/1.1\r\nHost: x\r\n\r\n")).await;
        assert!(
            !r.contains(&sala.code),
            "o código da sala vazou em {rota} para quem só abriu o endereço"
        );
        assert!(
            !r.contains("Anfitriã"),
            "o nome do anfitrião vazou em {rota} antes de alguém entrar"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn quadro_binario_malformado_nao_derruba_a_conexao() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("t", Mode::Rw);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "Primo").await;

    // O que um cliente hostil montaria à mão: tamanho de id maior que o
    // quadro, opcode desconhecido, quadro vazio, e um JSON que não é do
    // protocolo.
    for lixo in [
        vec![OP_INPUT, 200, b'a'],
        vec![0xff, 1, b't', b'x'],
        vec![],
        vec![OP_INPUT],
    ] {
        c.ws
            .send(Message::binary(lixo))
            .await
            .expect("enviar lixo");
    }
    c.envia(json!({ "t": "inexistente", "campo": 1 })).await;
    c.envia(json!({ "nem": "protocolo" })).await;

    // A sala continua de pé e a conexão continua servindo.
    c.digita("t", b"ainda funciona").await;
    sala.pty.aguarda_escrita("t", b"ainda funciona").await;

    // Com acento de propósito: o quadro é binário e não pode mexer nos bytes.
    sala.hub.on_pty_data("t", "e a saída também".as_bytes(), 5);
    let q = c.binario().await;
    assert_eq!(q.dados, "e a saída também".as_bytes());
}

#[tokio::test(flavor = "multi_thread")]
async fn quem_cai_e_volta_com_o_token_e_a_mesma_pessoa() {
    let sala = Sala::abrir(true).await;
    sala.compartilha("s1", Mode::Ro);

    let mut c = Convidado::conecta(sala.porta).await;
    c.hello(&sala.code, "Primo").await;
    assert_eq!(c.json().await["t"], "pending");
    let id = sala.hub.host_state().room.unwrap().pending[0].id.clone();
    sala.hub.decidir(&id, true);

    let welcome = c.json_do_tipo("welcome").await;
    let token = welcome["resumeToken"].as_str().unwrap().to_string();
    let cor = welcome["you"]["color"].clone();
    drop(c);

    // Volta com o token: numa sala com aprovação ligada, não pode haver um
    // segundo pedido esperando na porta do anfitrião.
    let mut de_volta = Convidado::conecta(sala.porta).await;
    de_volta
        .envia(json!({
            "t": "hello",
            "version": PROTOCOL_VERSION,
            "code": sala.code,
            "name": "Primo",
            "resumeToken": token,
        }))
        .await;

    let welcome = de_volta.json_do_tipo("welcome").await;
    assert_eq!(welcome["you"]["id"], id, "voltou como outra pessoa");
    assert_eq!(welcome["you"]["color"], cor, "a cor mudou depois da queda");
    assert!(
        sala.hub.host_state().room.unwrap().pending.is_empty(),
        "a reconexão bateu de novo na porta do anfitrião"
    );

    sala.hub.on_pty_data("s1", b"de volta", 2);
    let q = de_volta.binario().await;
    assert_eq!(q.dados, b"de volta");
}

#[tokio::test(flavor = "multi_thread")]
async fn conexao_que_nao_se_apresenta_e_cortada() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("s1", Mode::Ro);

    // Abre e fica calado. Enquanto isso a sala segue atendendo quem fala.
    let _mudo = Convidado::conecta(sala.porta).await;

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "Primo").await;

    sala.hub.on_pty_data("s1", b"vida normal", 1);
    let q = c.binario().await;
    assert_eq!(q.dados, b"vida normal");

    // E o calado nunca é contado como gente na sala.
    let participantes = sala.hub.host_state().room.unwrap().participants;
    assert_eq!(
        participantes.len(),
        2,
        "uma conexão que nunca se apresentou virou participante"
    );
}

/* ------------------------- ajuste de tamanho ----------------------------- */

#[tokio::test(flavor = "multi_thread")]
async fn convidado_ajusta_o_terminal_a_tela_dele() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("s1", Mode::Rw);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "No celular").await;
    c.envia(json!({ "t": "fit", "sessionId": "s1", "cols": 52, "rows": 20 }))
        .await;

    sala.pty.aguarda_ajustes("s1", vec![Some((52, 20))]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn quem_so_assiste_nao_mexe_no_tamanho() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("so-olhando", Mode::Ro);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "Espiã").await;
    c.envia(json!({ "t": "fit", "sessionId": "so-olhando", "cols": 40, "rows": 12 }))
        .await;

    // Uma tecla depois do `fit`, num terminal que aceita teclas, serve de
    // marcador: quando ela chega, o `fit` já foi processado e descartado.
    sala.compartilha("pode-digitar", Mode::Rw);
    c.digita("pode-digitar", b"x").await;
    sala.pty.aguarda_escrita("pode-digitar", b"x").await;

    assert!(
        sala.pty.ajustes_de("so-olhando").is_empty(),
        "quem só assiste encolheu o terminal do anfitrião"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_nao_compartilhado_nao_muda_de_tamanho() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("visivel", Mode::Rw);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "Curiosa").await;
    c.envia(json!({ "t": "fit", "sessionId": "invisivel", "cols": 40, "rows": 12 }))
        .await;

    c.digita("visivel", b"x").await;
    sala.pty.aguarda_escrita("visivel", b"x").await;

    assert!(
        sala.pty.ajustes_de("invisivel").is_empty(),
        "um terminal que nunca foi compartilhado foi redimensionado pela rede"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn tamanho_absurdo_e_aparado_antes_de_chegar_ao_pty() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("s1", Mode::Rw);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "Zoeira").await;

    // Uma coluna deixaria o terminal do anfitrião inutilizável com uma única
    // mensagem — é o ataque mais barato que este recurso abriria.
    c.envia(json!({ "t": "fit", "sessionId": "s1", "cols": 1, "rows": 1 }))
        .await;
    sala.pty.aguarda_ajustes("s1", vec![Some((20, 5))]).await;

    c.envia(json!({ "t": "fit", "sessionId": "s1", "cols": 65000, "rows": 65000 }))
        .await;
    sala.pty
        .aguarda_ajustes("s1", vec![Some((20, 5)), Some((400, 200))])
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn desistir_do_ajuste_devolve_o_tamanho() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("s1", Mode::Rw);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "No celular").await;
    c.envia(json!({ "t": "fit", "sessionId": "s1", "cols": 52, "rows": 20 }))
        .await;
    sala.pty.aguarda_ajustes("s1", vec![Some((52, 20))]).await;

    c.envia(json!({ "t": "unfit", "sessionId": "s1" })).await;
    sala.pty
        .aguarda_ajustes("s1", vec![Some((52, 20)), None])
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn celular_que_some_da_rede_devolve_o_tamanho_sozinho() {
    let sala = Sala::abrir(false).await;
    sala.compartilha("s1", Mode::Rw);

    let mut c = Convidado::conecta(sala.porta).await;
    c.entra(&sala.code, "No celular").await;
    c.envia(json!({ "t": "fit", "sessionId": "s1", "cols": 52, "rows": 20 }))
        .await;
    sala.pty.aguarda_ajustes("s1", vec![Some((52, 20))]).await;

    // Sem `unfit`, sem `close`: o socket simplesmente morre, que é o que
    // acontece quando o celular entra no elevador.
    drop(c);

    sala.pty
        .aguarda_ajustes("s1", vec![Some((52, 20)), None])
        .await;
}

/* ---------------------------- sala de bancada ---------------------------- */

/// Uma sala de verdade, numa porta fixa, para olhar com os próprios olhos.
///
/// Não é um teste — é o banco de bancada do app do celular, e por isso é
/// `#[ignore]`: ele não termina sozinho. O que ele resolve é um buraco real de
/// verificação. Tudo o que a suíte prova aqui é sobre bytes e permissões;
/// nada disso responde se a barra de teclas fica acima do teclado do celular
/// ou se o terminal nasce no tamanho certo — e essas são justamente as
/// perguntas que este app existe para acertar.
///
/// ```text
/// cargo test --test qa_collab_e2e sala_de_bancada -- --ignored --nocapture
/// ```
///
/// Depois é só abrir `http://localhost:7391/#c=<código>` — no navegador do
/// computador com a janela estreita, ou no celular pelo IP da máquina.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "não termina: é para inspecionar o app do celular à mão"]
async fn sala_de_bancada() {
    /// Devolve o que recebe, como um shell devolveria o eco da digitação, e
    /// responde `\r` com uma linha nova e um prompt.
    struct Eco {
        hub: Mutex<Option<Arc<CollabHub>>>,
        seq: Mutex<u64>,
    }

    impl PtyAccess for Eco {
        fn write(&self, session_id: &str, bytes: &[u8]) {
            let guard = self.hub.lock();
            let Some(hub) = guard.as_ref() else { return };
            let mut saida = Vec::new();
            for b in bytes {
                match b {
                    b'\r' => saida.extend_from_slice(b"\r\n$ "),
                    0x7f => saida.extend_from_slice(b"\x08 \x08"),
                    outro => saida.push(*outro),
                }
            }
            let mut seq = self.seq.lock();
            *seq += saida.len() as u64;
            hub.on_pty_data(session_id, &saida, *seq);
        }

        fn snapshot(&self, _session_id: &str) -> Option<Snapshot> {
            Some(Snapshot {
                bytes: b"JARVIS - sala de bancada\r\n$ ".to_vec(),
                seq: 0,
            })
        }

        fn fit(&self, session_id: &str, view_id: &str, cols: u16, rows: u16) {
            println!("[bancada] {session_id} ajustado para {cols}x{rows} por {view_id}");
        }

        fn unfit(&self, session_id: &str, view_id: &str) {
            println!("[bancada] {session_id} solto por {view_id}");
        }
    }

    let hub = Arc::new(CollabHub::new());
    let pty = Arc::new(Eco {
        hub: Mutex::new(Some(Arc::clone(&hub))),
        seq: Mutex::new(0),
    });

    let (listener, porta) = server::bind(7391).await.expect("porta 7391 livre");
    let code = hub.open(
        &StartOptions {
            name: Some("Bancada".into()),
            host_name: Some("Anfitrião".into()),
            port: porta,
            require_approval: false,
            public: false,
        },
        porta,
        None,
    );
    hub.share(SharedTerminal {
        session_id: "bancada".into(),
        title: "PowerShell".into(),
        mode: Mode::Rw,
        cols: 80,
        rows: 24,
        alive: true,
        folder: Some("JARVIS".into()),
    });

    let url = format!("http://localhost:{porta}/#c={code}");
    eprintln!("\n  {url}\n");
    // Também em arquivo: com a saída do `cargo test` num pipe, o endereço só
    // apareceria quando a sala fechasse — e ela não fecha.
    let _ = std::fs::write(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/bancada.txt"),
        &url,
    );

    let pty_srv: Arc<dyn PtyAccess> = pty;
    server::serve(listener, hub, pty_srv).await;
}
