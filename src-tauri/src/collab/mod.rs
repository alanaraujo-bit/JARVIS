//! Trabalho compartilhado: a sala, quem está nela e o que cada um pode fazer.
//!
//! O desenho parte de uma restrição: **nada disto pode custar nada quando
//! ninguém está compartilhando**. O motor de PTY entrega cada lote de saída a
//! este módulo pela mesma chamada que já entrega ao WebView, e essa chamada
//! acontece ~125 vezes por segundo por terminal ativo. Com a sala fechada, o
//! caminho inteiro é uma leitura atômica relaxada e um `return` — nem lock,
//! nem alocação, nem cópia de bytes.
//!
//! Com a sala aberta, a saída vai para um `broadcast` do tokio: o lote é
//! empacotado **uma vez** num `Arc` e todas as conexões recebem o mesmo
//! ponteiro. Dois convidados não custam dois empacotamentos.
//!
//! ## Superfície exposta
//!
//! O convidado não ganha "acesso à máquina". Ele ganha acesso a uma lista
//! explícita de terminais que o anfitrião marcou, um por um, e a nada mais:
//! não há comando de listar pastas, abrir arquivo, criar terminal ou executar
//! programa. Tudo o que ele pode enviar são teclas para um PTY que já existia
//! e que o anfitrião escolheu mostrar — e mesmo isso só se o modo daquele
//! terminal for `rw`. O resto do protocolo é chat, IA e leitura de tela.

pub mod protocol;
pub mod server;
pub mod tunnel;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, oneshot};

use crate::pty::now_ms;
use protocol::{
    frame_com_seq, AiEvent, ChatMessage, Mode, Participant, Role, RoomInfo, ServerMsg,
    SharedTerminal, OP_DATA,
};

/// Evento único para a interface do anfitrião. Um só, com o estado inteiro
/// dentro: a alternativa (um evento por tipo de mudança) obrigaria o front a
/// costurar fragmentos e a reconciliar ordens de chegada, para economizar
/// alguns bytes numa mensagem que acontece quando alguém entra numa sala.
pub const EV_COLLAB: &str = "collab:state";

/// Pergunta de um convidado à IA, encaminhada à tela do anfitrião. É lá que a
/// resposta é gerada — o motor de IA, as chaves e o contexto do terminal já
/// vivem no front do anfitrião, e duplicá-los aqui seria manter dois
/// caminhos para a mesma coisa.
pub const EV_COLLAB_AI: &str = "collab:ai-ask";

/// Teto do histórico de chat guardado para quem entra depois. Não é o
/// histórico da conversa — é o "contexto das últimas mensagens" que evita
/// alguém entrar numa sala e ver uma tela em branco.
const CHAT_MAX: usize = 200;

/// Capacidade da fila de saída por conexão. Cada item é um `Arc`, então o
/// custo é o ponteiro, não os bytes. Um convidado numa rede ruim que não
/// consegue drenar 512 lotes (~4 segundos de saída contínua) perdeu o fio de
/// qualquer forma: ele é desconectado e reconecta pedindo o estado da tela de
/// novo, o que é mais rápido e mais correto do que entregar minutos de saída
/// atrasada.
const CANAL_CAP: usize = 512;

/// Cores dos participantes, na ordem em que entram.
const CORES: [&str; 8] = [
    "#5eead4", "#a78bfa", "#fbbf24", "#f472b6", "#60a5fa", "#34d399", "#fb923c", "#e879f9",
];

/* ------------------------------- saída ---------------------------------- */

/// O que trafega no `broadcast` para as conexões.
#[derive(Debug)]
pub enum Out {
    Text(String),
    Bin(Vec<u8>),
}

/* ------------------------------ estado ---------------------------------- */

struct Guest {
    p: Participant,
    /// Chave de reentrada. Quem cai e volta com ela recupera a identidade e
    /// pula a aprovação — a alternativa seria o anfitrião ter que aprovar de
    /// novo a cada oscilação de Wi-Fi do convidado.
    resume_token: String,
    /// Quantas conexões desta pessoa estão abertas agora. Normalmente 0 ou 1;
    /// durante uma reconexão as duas coexistem por um instante, e um simples
    /// booleano faria a conexão velha, ao morrer, marcar como offline alguém
    /// que já tinha voltado.
    conexoes: u32,
}

struct Pendente {
    id: String,
    name: String,
    at: u64,
    /// Avisa a conexão que está esperando. `bool` = aprovado.
    decisao: Option<oneshot::Sender<bool>>,
}

struct Room {
    name: String,
    host_name: String,
    code: String,
    port: u16,
    lan_url: Option<String>,
    require_approval: bool,
    /// Ordem importa: é a ordem em que os terminais aparecem para o convidado,
    /// e ela deve ser a mesma em que o anfitrião os compartilhou.
    ordem: Vec<String>,
    terminais: HashMap<String, SharedTerminal>,
    guests: HashMap<String, Guest>,
    tokens: HashMap<String, String>,
    pendentes: Vec<Pendente>,
    /// Quem já foi expulso não volta com o mesmo código. Sem isto, "remover"
    /// seria um pedido, não uma decisão: o convidado reconectaria em um
    /// segundo.
    banidos: HashSet<String>,
    chat: VecDeque<ChatMessage>,
    revision: u64,
    started_at: u64,
}

impl Room {
    fn terminais_ordenados(&self) -> Vec<SharedTerminal> {
        self.ordem
            .iter()
            .filter_map(|id| self.terminais.get(id).cloned())
            .collect()
    }

    fn participantes(&self) -> Vec<Participant> {
        let mut v: Vec<Participant> = std::iter::once(Participant {
            id: "host".into(),
            name: self.host_name.clone(),
            color: "#5eead4".into(),
            role: Role::Host,
            online: true,
            joined_at: self.started_at,
        })
        .chain(self.guests.values().map(|g| g.p.clone()))
        .collect();
        v.sort_by_key(|p| p.joined_at);
        v
    }
}

/* ------------------------- estado visto pelo front ---------------------- */

/// Foto do trabalho compartilhado para a interface do anfitrião.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostState {
    pub active: bool,
    pub room: Option<HostRoom>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRoom {
    pub name: String,
    pub host_name: String,
    pub code: String,
    pub port: u16,
    pub lan_url: Option<String>,
    pub public_url: Option<String>,
    pub tunnel: tunnel::TunnelState,
    pub require_approval: bool,
    pub terminals: Vec<SharedTerminal>,
    pub participants: Vec<Participant>,
    pub pending: Vec<PendingView>,
    pub chat: Vec<ChatMessage>,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    pub id: String,
    pub name: String,
    pub at: u64,
}

/// Opções de abertura da sala, vindas do front.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub host_name: Option<String>,
    /// `0` = o sistema escolhe uma porta livre.
    #[serde(default)]
    pub port: u16,
    /// Aprovar cada entrada na mão. Ligado por padrão: a sala pode estar
    /// exposta à internet por um túnel, e o código sozinho não deve ser a
    /// única coisa entre um desconhecido e um shell.
    #[serde(default = "sim")]
    pub require_approval: bool,
    /// Subir o túnel público junto com a sala.
    #[serde(default)]
    pub public: bool,
}

fn sim() -> bool {
    true
}

/* -------------------------------- hub ----------------------------------- */

pub struct CollabHub {
    /// Guarda do caminho quente. Lido a cada lote de saída de PTY, escrito
    /// duas vezes na vida de uma sala.
    ativo: AtomicBool,
    room: RwLock<Option<Room>>,
    tx: broadcast::Sender<Arc<Out>>,
    app: Mutex<Option<AppHandle>>,
    pub tunnel: tunnel::Tunnel,
    /// Tentativas de entrada com código errado. Serve ao freio contra força
    /// bruta: 8 caracteres de um alfabeto de 31 dão ~40 bits, mas nada disso
    /// vale se um script puder tentar mil vezes por segundo.
    erros_de_codigo: AtomicU64,
}

impl CollabHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(CANAL_CAP);
        Self {
            ativo: AtomicBool::new(false),
            room: RwLock::new(None),
            tx,
            app: Mutex::new(None),
            tunnel: tunnel::Tunnel::new(),
            erros_de_codigo: AtomicU64::new(0),
        }
    }

    pub fn attach(&self, app: AppHandle) {
        *self.app.lock() = Some(app);
    }

    fn app(&self) -> Option<AppHandle> {
        self.app.lock().clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Out>> {
        self.tx.subscribe()
    }

    /* ---------------------------- caminho quente ------------------------ */

    /// Saída de um PTY. Chamado pela thread despachante a cada lote.
    pub fn on_pty_data(&self, session_id: &str, bytes: &[u8], seq: u64) {
        // Sala fechada: uma leitura atômica e nada mais. É o caso normal.
        if !self.ativo.load(Ordering::Relaxed) {
            return;
        }
        {
            let guard = self.room.read();
            let Some(room) = guard.as_ref() else { return };
            // Terminal que não foi compartilhado não sai da máquina.
            if !room.terminais.contains_key(session_id) {
                return;
            }
        }
        // Ninguém conectado: não empacota. Um `send` sem receptor devolve erro
        // de qualquer forma, mas a alocação do quadro já teria acontecido.
        if self.tx.receiver_count() == 0 {
            return;
        }
        let _ = self
            .tx
            .send(Arc::new(Out::Bin(frame_com_seq(OP_DATA, session_id, seq, bytes))));
    }

    /// Um processo compartilhado morreu.
    pub fn on_pty_exit(&self, session_id: &str, exit_code: i32) {
        if !self.ativo.load(Ordering::Relaxed) {
            return;
        }
        let mudou = {
            let mut guard = self.room.write();
            let Some(room) = guard.as_mut() else { return };
            match room.terminais.get_mut(session_id) {
                Some(t) => {
                    t.alive = false;
                    true
                }
                None => false,
            }
        };
        if !mudou {
            return;
        }
        self.broadcast(&ServerMsg::Exit {
            session_id: session_id.to_string(),
            exit_code,
        });
        self.publicar();
    }

    /* ------------------------------- sala ------------------------------- */

    pub fn is_active(&self) -> bool {
        self.ativo.load(Ordering::Relaxed)
    }

    /// Abre a sala. O servidor é subido por `commands`, que devolve a porta
    /// de fato aberta — pedir `0` e receber a escolhida pelo sistema é o
    /// único jeito de não colidir com outra coisa na máquina.
    pub fn open(&self, opts: &StartOptions, port: u16, lan_url: Option<String>) -> String {
        let code = gerar_codigo();
        let room = Room {
            name: opts
                .name
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "Trabalho compartilhado".into()),
            host_name: opts
                .host_name
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "Anfitrião".into()),
            code: code.clone(),
            port,
            lan_url,
            require_approval: opts.require_approval,
            ordem: Vec::new(),
            terminais: HashMap::new(),
            guests: HashMap::new(),
            tokens: HashMap::new(),
            pendentes: Vec::new(),
            banidos: HashSet::new(),
            chat: VecDeque::new(),
            revision: 1,
            started_at: now_ms(),
        };
        *self.room.write() = Some(room);
        self.erros_de_codigo.store(0, Ordering::Relaxed);
        // Por último: a partir daqui o caminho quente passa a olhar a sala.
        self.ativo.store(true, Ordering::Release);
        self.publicar();
        code
    }

    /// Fecha a sala e derruba todo mundo.
    pub fn close(&self, reason: &str) {
        if !self.ativo.swap(false, Ordering::AcqRel) {
            return;
        }
        // Avisa antes de limpar: as conexões precisam do motivo para mostrar
        // "o anfitrião encerrou" em vez de "conexão perdida".
        self.broadcast(&ServerMsg::Bye {
            reason: reason.to_string(),
        });
        // Solta quem esperava aprovação, senão a tarefa da conexão fica
        // pendurada num `oneshot` que nunca chega.
        if let Some(room) = self.room.write().as_mut() {
            for p in room.pendentes.iter_mut() {
                if let Some(tx) = p.decisao.take() {
                    let _ = tx.send(false);
                }
            }
        }
        *self.room.write() = None;
        self.tunnel.stop();
        self.publicar();
    }

    pub fn set_require_approval(&self, valor: bool) {
        if let Some(room) = self.room.write().as_mut() {
            room.require_approval = valor;
        }
        self.publicar();
    }

    /* ----------------------------- terminais ---------------------------- */

    /// Compartilha um terminal, ou atualiza o modo de um já compartilhado.
    pub fn share(&self, t: SharedTerminal) {
        {
            let mut guard = self.room.write();
            let Some(room) = guard.as_mut() else { return };
            if !room.terminais.contains_key(&t.session_id) {
                room.ordem.push(t.session_id.clone());
            }
            room.terminais.insert(t.session_id.clone(), t);
            room.revision += 1;
        }
        self.anunciar_terminais();
    }

    pub fn unshare(&self, session_id: &str) {
        {
            let mut guard = self.room.write();
            let Some(room) = guard.as_mut() else { return };
            if room.terminais.remove(session_id).is_none() {
                return;
            }
            room.ordem.retain(|id| id != session_id);
            room.revision += 1;
        }
        self.anunciar_terminais();
    }

    /// Tamanho real do PTY mudou: os convidados precisam refletir para as
    /// telas continuarem idênticas.
    pub fn on_resize(&self, session_id: &str, cols: u16, rows: u16) {
        if !self.ativo.load(Ordering::Relaxed) {
            return;
        }
        let mudou = {
            let mut guard = self.room.write();
            let Some(room) = guard.as_mut() else { return };
            match room.terminais.get_mut(session_id) {
                Some(t) if t.cols != cols || t.rows != rows => {
                    t.cols = cols;
                    t.rows = rows;
                    true
                }
                _ => false,
            }
        };
        if mudou {
            self.broadcast(&ServerMsg::Size {
                session_id: session_id.to_string(),
                cols,
                rows,
            });
        }
    }

    /// Modo de um terminal para um convidado. `None` = não compartilhado.
    pub fn modo(&self, session_id: &str) -> Option<Mode> {
        self.room
            .read()
            .as_ref()
            .and_then(|r| r.terminais.get(session_id))
            .map(|t| t.mode)
    }

    pub fn tamanho_atual(&self, session_id: &str) -> Option<(u16, u16)> {
        self.room
            .read()
            .as_ref()
            .and_then(|r| r.terminais.get(session_id))
            .map(|t| (t.cols, t.rows))
    }

    /* ---------------------------- entrada de gente ---------------------- */

    /// Confere o código. Devolve `Err` com a mensagem que o convidado verá.
    pub fn checar_codigo(&self, code: &str) -> Result<(), String> {
        // Não vale a pena um algoritmo de tempo constante aqui: o código é
        // curto e o canal é a rede, cujo ruído é ordens de grandeza maior que
        // a diferença de tempo de um `==` de string. O que de fato protege é
        // o teto de tentativas logo abaixo.
        if self.erros_de_codigo.load(Ordering::Relaxed) >= 20 {
            return Err(
                "Muitas tentativas com código errado. O anfitrião precisa reabrir a sala.".into(),
            );
        }
        let guard = self.room.read();
        let Some(room) = guard.as_ref() else {
            return Err("Não há nenhuma sala aberta neste computador.".into());
        };
        if normaliza_codigo(code) != room.code {
            drop(guard);
            self.erros_de_codigo.fetch_add(1, Ordering::Relaxed);
            self.publicar();
            return Err("Código incorreto.".into());
        }
        Ok(())
    }

    /// Alguém está entrando. Devolve o participante, o token de reentrada e
    /// se ainda precisa de aprovação.
    ///
    /// `resume_token` reconduz a pessoa à identidade anterior; é o que faz uma
    /// queda de Wi-Fi não custar uma nova aprovação nem uma cor nova na lista.
    pub fn join(
        &self,
        nome: &str,
        resume_token: Option<&str>,
    ) -> Result<(Participant, String, bool), String> {
        let mut guard = self.room.write();
        let Some(room) = guard.as_mut() else {
            return Err("A sala foi encerrada.".into());
        };

        if let Some(token) = resume_token {
            if let Some(id) = room.tokens.get(token).cloned() {
                if room.banidos.contains(&id) {
                    return Err("O anfitrião removeu você desta sala.".into());
                }
                if let Some(g) = room.guests.get_mut(&id) {
                    g.conexoes += 1;
                    g.p.online = true;
                    let p = g.p.clone();
                    let t = g.resume_token.clone();
                    room.revision += 1;
                    drop(guard);
                    self.anunciar_participantes();
                    return Ok((p, t, false));
                }
            }
        }

        let nome = limpa_nome(nome);
        let id = uuid::Uuid::new_v4().to_string();
        let token = uuid::Uuid::new_v4().to_string();
        let cor = CORES[(room.guests.len() + 1) % CORES.len()];
        let p = Participant {
            id: id.clone(),
            name: nome,
            color: cor.to_string(),
            role: Role::Guest,
            online: true,
            joined_at: now_ms(),
        };
        let precisa_aprovar = room.require_approval;

        if precisa_aprovar {
            // Ainda não entra na lista de participantes: quem está esperando
            // aprovação não recebe quadro nenhum, nem aparece como presente.
            room.pendentes.push(Pendente {
                id: id.clone(),
                name: p.name.clone(),
                at: p.joined_at,
                decisao: None,
            });
        } else {
            room.tokens.insert(token.clone(), id.clone());
            room.guests.insert(
                id.clone(),
                Guest {
                    p: p.clone(),
                    resume_token: token.clone(),
                    conexoes: 1,
                },
            );
            room.revision += 1;
        }
        drop(guard);

        if precisa_aprovar {
            self.publicar();
        } else {
            self.anunciar_participantes();
        }
        Ok((p, token, precisa_aprovar))
    }

    /// Registra por onde avisar a conexão que espera aprovação.
    pub fn aguardar_aprovacao(&self, id: &str) -> Option<oneshot::Receiver<bool>> {
        let (tx, rx) = oneshot::channel();
        let mut guard = self.room.write();
        let room = guard.as_mut()?;
        let p = room.pendentes.iter_mut().find(|p| p.id == id)?;
        p.decisao = Some(tx);
        Some(rx)
    }

    /// O anfitrião decidiu sobre alguém que estava esperando.
    pub fn decidir(&self, id: &str, aprovado: bool) {
        let mut guard = self.room.write();
        let Some(room) = guard.as_mut() else { return };
        let Some(pos) = room.pendentes.iter().position(|p| p.id == id) else {
            return;
        };
        let mut pendente = room.pendentes.remove(pos);

        if aprovado {
            let token = uuid::Uuid::new_v4().to_string();
            let cor = CORES[(room.guests.len() + 1) % CORES.len()];
            room.tokens.insert(token.clone(), id.to_string());
            room.guests.insert(
                id.to_string(),
                Guest {
                    p: Participant {
                        id: id.to_string(),
                        name: pendente.name.clone(),
                        color: cor.to_string(),
                        role: Role::Guest,
                        online: true,
                        joined_at: pendente.at,
                    },
                    resume_token: token,
                    conexoes: 1,
                },
            );
            room.revision += 1;
        }
        if let Some(tx) = pendente.decisao.take() {
            let _ = tx.send(aprovado);
        }
        drop(guard);
        if aprovado {
            self.anunciar_participantes();
        } else {
            self.publicar();
        }
    }

    /// Dados que a conexão precisa depois de aprovada.
    pub fn dados_de_entrada(&self, id: &str) -> Option<(Participant, String)> {
        let guard = self.room.read();
        let g = guard.as_ref()?.guests.get(id)?;
        Some((g.p.clone(), g.resume_token.clone()))
    }

    pub fn welcome(&self, you: Participant, resume_token: String) -> Option<ServerMsg> {
        let guard = self.room.read();
        let room = guard.as_ref()?;
        Some(ServerMsg::Welcome {
            you,
            room: RoomInfo {
                name: room.name.clone(),
                host_name: room.host_name.clone(),
                revision: room.revision,
            },
            terminals: room.terminais_ordenados(),
            participants: room.participantes(),
            chat: room.chat.iter().cloned().collect(),
            resume_token,
        })
    }

    pub fn nome_da_sala(&self) -> (String, String) {
        let guard = self.room.read();
        match guard.as_ref() {
            Some(r) => (r.name.clone(), r.host_name.clone()),
            None => ("Trabalho compartilhado".into(), "Anfitrião".into()),
        }
    }

    /// A conexão de um convidado caiu.
    pub fn on_disconnect(&self, id: &str) {
        {
            let mut guard = self.room.write();
            let Some(room) = guard.as_mut() else { return };
            // Um pendente que desiste sai da fila: senão o anfitrião fica
            // olhando para um pedido de alguém que já fechou o app.
            room.pendentes.retain(|p| p.id != id);
            if let Some(g) = room.guests.get_mut(id) {
                g.conexoes = g.conexoes.saturating_sub(1);
                if g.conexoes == 0 {
                    g.p.online = false;
                }
            }
            room.revision += 1;
        }
        self.anunciar_participantes();
    }

    /// Expulsa e impede o retorno com o mesmo código.
    pub fn kick(&self, id: &str) {
        {
            let mut guard = self.room.write();
            let Some(room) = guard.as_mut() else { return };
            room.guests.remove(id);
            room.tokens.retain(|_, v| v != id);
            room.banidos.insert(id.to_string());
            room.pendentes.retain(|p| p.id != id);
            room.revision += 1;
        }
        // A conexão dele lê isto e se encerra sozinha.
        self.broadcast_para(id, &ServerMsg::Denied {
            reason: "O anfitrião removeu você da sala.".into(),
        });
        self.anunciar_participantes();
    }

    pub fn esta_dentro(&self, id: &str) -> bool {
        self.room
            .read()
            .as_ref()
            .map(|r| r.guests.contains_key(id))
            .unwrap_or(false)
    }

    /* ------------------------------- chat ------------------------------- */

    pub fn post_chat(&self, autor_id: &str, texto: &str) -> Option<ChatMessage> {
        let texto = texto.trim();
        if texto.is_empty() {
            return None;
        }
        // Teto de tamanho: uma mensagem de megabytes seria retransmitida a
        // todos os participantes e guardada no histórico da sala.
        let texto: String = texto.chars().take(4000).collect();

        let msg = {
            let mut guard = self.room.write();
            let room = guard.as_mut()?;
            let (nome, cor) = if autor_id == "host" {
                (room.host_name.clone(), "#5eead4".to_string())
            } else {
                let g = room.guests.get(autor_id)?;
                (g.p.name.clone(), g.p.color.clone())
            };
            let msg = ChatMessage {
                id: uuid::Uuid::new_v4().to_string(),
                author_id: autor_id.to_string(),
                author_name: nome,
                author_color: cor,
                text: texto,
                at: now_ms(),
            };
            room.chat.push_back(msg.clone());
            while room.chat.len() > CHAT_MAX {
                room.chat.pop_front();
            }
            msg
        };
        self.broadcast(&ServerMsg::Chat {
            message: msg.clone(),
        });
        self.publicar();
        Some(msg)
    }

    /* -------------------------------- IA -------------------------------- */

    /// Um convidado perguntou algo à IA. O anfitrião é quem responde: este
    /// método só encaminha o pedido à tela dele e espelha a pergunta para
    /// todos, para a conversa ser a mesma nas duas pontas.
    pub fn ai_ask(&self, autor_id: &str, texto: &str) {
        let texto = texto.trim();
        if texto.is_empty() {
            return;
        }
        let texto: String = texto.chars().take(8000).collect();
        let Some((nome, cor)) = self.autor(autor_id) else {
            return;
        };
        let request_id = uuid::Uuid::new_v4().to_string();
        let evento = AiEvent::Ask {
            request_id: request_id.clone(),
            author_name: nome,
            author_color: cor,
            text: texto,
        };
        self.broadcast(&ServerMsg::Ai {
            event: evento.clone(),
        });
        if let Some(app) = self.app() {
            let _ = app.emit(EV_COLLAB_AI, &evento);
        }
    }

    /// Retransmite aos convidados um pedaço da resposta gerada no anfitrião.
    pub fn ai_relay(&self, event: AiEvent) {
        self.broadcast(&ServerMsg::Ai { event });
    }

    fn autor(&self, id: &str) -> Option<(String, String)> {
        let guard = self.room.read();
        let room = guard.as_ref()?;
        if id == "host" {
            return Some((room.host_name.clone(), "#5eead4".into()));
        }
        room.guests
            .get(id)
            .map(|g| (g.p.name.clone(), g.p.color.clone()))
    }

    /* ----------------------------- distribuição -------------------------- */

    fn broadcast(&self, msg: &ServerMsg) {
        if self.tx.receiver_count() == 0 {
            return;
        }
        if let Ok(json) = serde_json::to_string(msg) {
            let _ = self.tx.send(Arc::new(Out::Text(json)));
        }
    }

    /// Mensagem endereçada. O canal é único, então vai um envelope junto e
    /// cada conexão descarta o que não é dela — a alternativa (um canal por
    /// conexão) duplicaria o empacotamento do caminho quente, que é o que
    /// mais importa aqui.
    fn broadcast_para(&self, destino: &str, msg: &ServerMsg) {
        if self.tx.receiver_count() == 0 {
            return;
        }
        if let Ok(json) = serde_json::to_string(msg) {
            let envelope = format!("@{destino}\n{json}");
            let _ = self.tx.send(Arc::new(Out::Text(envelope)));
        }
    }

    fn anunciar_terminais(&self) {
        let dados = {
            let guard = self.room.read();
            guard
                .as_ref()
                .map(|r| (r.terminais_ordenados(), r.revision))
        };
        if let Some((terminals, revision)) = dados {
            self.broadcast(&ServerMsg::Terminals {
                terminals,
                revision,
            });
        }
        self.publicar();
    }

    fn anunciar_participantes(&self) {
        let dados = {
            let guard = self.room.read();
            guard.as_ref().map(|r| (r.participantes(), r.revision))
        };
        if let Some((participants, revision)) = dados {
            self.broadcast(&ServerMsg::Participants {
                participants,
                revision,
            });
        }
        self.publicar();
    }

    /* --------------------------- estado do anfitrião --------------------- */

    pub fn host_state(&self) -> HostState {
        let guard = self.room.read();
        let Some(room) = guard.as_ref() else {
            return HostState {
                active: false,
                room: None,
            };
        };
        HostState {
            active: true,
            room: Some(HostRoom {
                name: room.name.clone(),
                host_name: room.host_name.clone(),
                code: room.code.clone(),
                port: room.port,
                lan_url: room.lan_url.clone(),
                public_url: self.tunnel.url(),
                tunnel: self.tunnel.state(),
                require_approval: room.require_approval,
                terminals: room.terminais_ordenados(),
                participants: room.participantes(),
                pending: room
                    .pendentes
                    .iter()
                    .map(|p| PendingView {
                        id: p.id.clone(),
                        name: p.name.clone(),
                        at: p.at,
                    })
                    .collect(),
                chat: room.chat.iter().cloned().collect(),
                started_at: room.started_at,
            }),
        }
    }

    /// Empurra o estado para a interface do anfitrião.
    pub fn publicar(&self) {
        if let Some(app) = self.app() {
            let _ = app.emit(EV_COLLAB, self.host_state());
        }
    }
}

impl Default for CollabHub {
    fn default() -> Self {
        Self::new()
    }
}

/* ------------------------------ utilidades ------------------------------ */

/// Alfabeto sem `0/O`, `1/I/L` e `U` (que vira `V` em muitas fontes): o
/// código é feito para ser lido em voz alta por telefone e digitado errado
/// uma vez a menos.
const ALFABETO: &[u8] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";

fn gerar_codigo() -> String {
    // O v4 é criptograficamente aleatório; os 8 primeiros bytes viram 8
    // caracteres, ~39 bits de entropia. Com o teto de tentativas, adivinhar
    // é impraticável mesmo com a sala exposta na internet.
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    let mut s = String::with_capacity(9);
    for (i, b) in bytes.iter().take(8).enumerate() {
        if i == 4 {
            s.push('-');
        }
        s.push(ALFABETO[*b as usize % ALFABETO.len()] as char);
    }
    s
}

/// Aceita o código como a pessoa digitar: minúsculo, sem hífen, com espaços.
pub fn normaliza_codigo(bruto: &str) -> String {
    let limpo: String = bruto
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if limpo.len() == 8 {
        format!("{}-{}", &limpo[..4], &limpo[4..])
    } else {
        limpo
    }
}

fn limpa_nome(bruto: &str) -> String {
    // Controle e quebra de linha viram nada: o nome aparece em lista, em
    // balão de chat e em aviso de entrada, e um `\n` ali quebraria o layout
    // de todos eles.
    let s: String = bruto
        .chars()
        .filter(|c| !c.is_control())
        .take(32)
        .collect::<String>()
        .trim()
        .to_string();
    if s.is_empty() {
        "Convidado".into()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codigo_tem_formato_legivel_e_sem_caractere_ambiguo() {
        for _ in 0..200 {
            let c = gerar_codigo();
            assert_eq!(c.len(), 9, "8 caracteres e um hífen: {c}");
            assert_eq!(&c[4..5], "-");
            for ch in c.chars().filter(|c| *c != '-') {
                assert!(
                    ALFABETO.contains(&(ch as u8)),
                    "{ch} não devia estar no alfabeto"
                );
            }
        }
    }

    #[test]
    fn codigo_e_aceito_como_a_pessoa_digita() {
        assert_eq!(normaliza_codigo("ab2c-3d4e"), "AB2C-3D4E");
        assert_eq!(normaliza_codigo("AB2C3D4E"), "AB2C-3D4E");
        assert_eq!(normaliza_codigo(" ab2c 3d4e "), "AB2C-3D4E");
    }

    #[test]
    fn nome_de_convidado_nao_quebra_o_layout() {
        assert_eq!(limpa_nome("  Primo\n\r  "), "Primo");
        assert_eq!(limpa_nome(""), "Convidado");
        assert_eq!(limpa_nome("   "), "Convidado");
        assert_eq!(limpa_nome(&"x".repeat(100)).len(), 32);
    }

    fn hub_com_sala() -> (CollabHub, String) {
        let hub = CollabHub::new();
        let code = hub.open(
            &StartOptions {
                name: Some("Sala".into()),
                host_name: Some("Alan".into()),
                port: 0,
                require_approval: false,
                public: false,
            },
            7391,
            None,
        );
        (hub, code)
    }

    #[test]
    fn sala_fechada_nao_expoe_nada() {
        let hub = CollabHub::new();
        assert!(!hub.is_active());
        assert_eq!(hub.modo("qualquer"), None);
        assert!(hub.checar_codigo("AAAA-AAAA").is_err());
    }

    #[test]
    fn terminal_nao_compartilhado_e_invisivel() {
        let (hub, _) = hub_com_sala();
        // Nenhum terminal compartilhado ainda: nem o modo existe.
        assert_eq!(hub.modo("s1"), None);

        hub.share(SharedTerminal {
            session_id: "s1".into(),
            title: "bash".into(),
            mode: Mode::Ro,
            cols: 80,
            rows: 24,
            alive: true,
            folder: None,
        });
        assert_eq!(hub.modo("s1"), Some(Mode::Ro));
        assert!(!hub.modo("s1").unwrap().pode_escrever());
        // O vizinho continua invisível.
        assert_eq!(hub.modo("s2"), None);

        hub.unshare("s1");
        assert_eq!(hub.modo("s1"), None);
    }

    #[test]
    fn codigo_errado_e_recusado_e_o_certo_passa() {
        let (hub, code) = hub_com_sala();
        assert!(hub.checar_codigo("ZZZZ-ZZZZ").is_err());
        assert!(hub.checar_codigo(&code).is_ok());
        // Aceita como a pessoa digita.
        assert!(hub.checar_codigo(&code.to_lowercase().replace('-', "")).is_ok());
    }

    #[test]
    fn forca_bruta_esbarra_no_teto_de_tentativas() {
        let (hub, code) = hub_com_sala();
        for _ in 0..20 {
            let _ = hub.checar_codigo("ZZZZ-ZZZZ");
        }
        // Depois do teto, nem o código certo entra: a sala tem que ser
        // reaberta. É deliberado — um atacante ativo não deve poder continuar
        // tentando, e o anfitrião está do lado da máquina para reabrir.
        assert!(hub.checar_codigo(&code).is_err());
    }

    #[test]
    fn entrada_sem_aprovacao_ja_nasce_dentro() {
        let (hub, _) = hub_com_sala();
        let (p, token, pendente) = hub.join("Primo", None).unwrap();
        assert!(!pendente);
        assert_eq!(p.name, "Primo");
        assert!(hub.esta_dentro(&p.id));

        // Reentrar com o token recupera a mesma identidade.
        let (p2, _, pend2) = hub.join("Outro Nome", Some(&token)).unwrap();
        assert_eq!(p2.id, p.id, "mesma pessoa depois de cair e voltar");
        assert!(!pend2);
    }

    #[test]
    fn entrada_com_aprovacao_espera_do_lado_de_fora() {
        let hub = CollabHub::new();
        hub.open(
            &StartOptions {
                name: None,
                host_name: None,
                port: 0,
                require_approval: true,
                public: false,
            },
            7391,
            None,
        );
        let (p, _, pendente) = hub.join("Primo", None).unwrap();
        assert!(pendente);
        assert!(
            !hub.esta_dentro(&p.id),
            "quem espera aprovação não é participante ainda"
        );
        assert_eq!(hub.host_state().room.unwrap().pending.len(), 1);

        hub.decidir(&p.id, true);
        assert!(hub.esta_dentro(&p.id));
        assert!(hub.host_state().room.unwrap().pending.is_empty());
    }

    #[test]
    fn recusa_deixa_a_pessoa_de_fora() {
        let hub = CollabHub::new();
        hub.open(
            &StartOptions {
                name: None,
                host_name: None,
                port: 0,
                require_approval: true,
                public: false,
            },
            7391,
            None,
        );
        let (p, _, _) = hub.join("Estranho", None).unwrap();
        hub.decidir(&p.id, false);
        assert!(!hub.esta_dentro(&p.id));
        assert!(hub.host_state().room.unwrap().pending.is_empty());
    }

    #[test]
    fn expulso_nao_volta_com_o_token_antigo() {
        let (hub, _) = hub_com_sala();
        let (p, token, _) = hub.join("Primo", None).unwrap();
        hub.kick(&p.id);
        assert!(!hub.esta_dentro(&p.id));

        // O token foi invalidado; voltar com ele cria uma pessoa nova (que
        // ainda passará pela aprovação, se ela estiver ligada).
        let (p2, _, _) = hub.join("Primo", Some(&token)).unwrap();
        assert_ne!(p2.id, p.id);
    }

    #[test]
    fn fechar_a_sala_desliga_o_caminho_quente() {
        let (hub, _) = hub_com_sala();
        hub.share(SharedTerminal {
            session_id: "s1".into(),
            title: "bash".into(),
            mode: Mode::Rw,
            cols: 80,
            rows: 24,
            alive: true,
            folder: None,
        });
        assert!(hub.is_active());
        hub.close("fim");
        assert!(!hub.is_active());
        assert_eq!(hub.modo("s1"), None);
        assert!(!hub.host_state().active);
        // Idempotente: fechar de novo não explode.
        hub.close("fim");
    }

    #[test]
    fn chat_guarda_so_o_rabo_do_historico() {
        let (hub, _) = hub_com_sala();
        for i in 0..(CHAT_MAX + 30) {
            hub.post_chat("host", &format!("msg {i}"));
        }
        let sala = hub.host_state().room.unwrap();
        assert_eq!(sala.chat.len(), CHAT_MAX);
        assert_eq!(sala.chat.last().unwrap().text, format!("msg {}", CHAT_MAX + 29));
    }

    #[test]
    fn chat_vazio_nao_vira_mensagem() {
        let (hub, _) = hub_com_sala();
        assert!(hub.post_chat("host", "   ").is_none());
        assert!(hub.post_chat("host", "").is_none());
        assert!(hub.host_state().room.unwrap().chat.is_empty());
    }

    #[test]
    fn terminais_mantem_a_ordem_em_que_foram_compartilhados() {
        let (hub, _) = hub_com_sala();
        for id in ["c", "a", "b"] {
            hub.share(SharedTerminal {
                session_id: id.into(),
                title: id.into(),
                mode: Mode::Rw,
                cols: 80,
                rows: 24,
                alive: true,
                folder: None,
            });
        }
        let sala = hub.host_state().room.unwrap();
        let ids: Vec<&str> = sala.terminals.iter().map(|t| t.session_id.as_str()).collect();
        assert_eq!(ids, vec!["c", "a", "b"]);

        // Trocar o modo não reordena.
        hub.share(SharedTerminal {
            session_id: "c".into(),
            title: "c".into(),
            mode: Mode::Ro,
            cols: 80,
            rows: 24,
            alive: true,
            folder: None,
        });
        let sala = hub.host_state().room.unwrap();
        let ids: Vec<&str> = sala.terminals.iter().map(|t| t.session_id.as_str()).collect();
        assert_eq!(ids, vec!["c", "a", "b"]);
        assert_eq!(hub.modo("c"), Some(Mode::Ro));
    }

    #[test]
    fn saida_de_processo_marca_o_terminal_como_morto() {
        let (hub, _) = hub_com_sala();
        hub.share(SharedTerminal {
            session_id: "s1".into(),
            title: "bash".into(),
            mode: Mode::Rw,
            cols: 80,
            rows: 24,
            alive: true,
            folder: None,
        });
        hub.on_pty_exit("s1", 0);
        let sala = hub.host_state().room.unwrap();
        assert!(!sala.terminals[0].alive);
    }

    #[test]
    fn dados_de_terminal_nao_compartilhado_nao_saem() {
        let (hub, _) = hub_com_sala();
        let mut rx = hub.subscribe();
        hub.share(SharedTerminal {
            session_id: "s1".into(),
            title: "bash".into(),
            mode: Mode::Rw,
            cols: 80,
            rows: 24,
            alive: true,
            folder: None,
        });
        // Drena o anúncio de terminais que o `share` emitiu.
        while rx.try_recv().is_ok() {}

        hub.on_pty_data("s2", b"segredo", 7);
        assert!(
            rx.try_recv().is_err(),
            "a saída de um terminal não compartilhado vazou"
        );

        hub.on_pty_data("s1", b"ok", 2);
        match rx.try_recv() {
            Ok(out) => match &*out {
                Out::Bin(b) => assert!(b.ends_with(b"ok")),
                Out::Text(t) => panic!("esperava quadro binário, veio {t}"),
            },
            Err(e) => panic!("o lote do terminal compartilhado não saiu: {e:?}"),
        }
    }
}
