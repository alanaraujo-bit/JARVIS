//! Protocolo do trabalho compartilhado.
//!
//! Duas famílias de quadro convivem na mesma conexão, e a separação é o que
//! sustenta a promessa de fluidez:
//!
//! - **Binário** para o que é volumoso e constante: a saída do PTY e as
//!   teclas do convidado. Sem base64 (que inflaria 33% cada byte que sai do
//!   shell) e sem JSON em volta. O cabeçalho é o mínimo para saber de que
//!   terminal se trata.
//! - **Texto (JSON)** para o que é raro e estruturado: entrar na sala, lista
//!   de participantes, chat, IA, aviso de saída de processo.
//!
//! O espelho em TypeScript vive em `src/lib/collabProtocol.ts`. Os dois
//! precisam mudar juntos — o campo `PROTOCOL_VERSION` existe justamente para
//! uma versão nova recusar educadamente uma antiga em vez de trocar bytes que
//! o outro lado interpreta errado.

use serde::{Deserialize, Serialize};

/// Sobe quando o formato deixa de ser compatível com a versão anterior.
/// O convidado manda a dele no `hello`; o anfitrião recusa o que não bate,
/// com uma mensagem que diz qual dos dois precisa atualizar.
pub const PROTOCOL_VERSION: u32 = 1;

/* ----------------------------- quadros binários ------------------------- */

/// Saída do PTY, do anfitrião para os convidados.
pub const OP_DATA: u8 = 0x01;
/// Teclas do convidado para o PTY do anfitrião.
pub const OP_INPUT: u8 = 0x02;
/// Estado inicial da tela de um terminal, ao entrar ou ao abri-lo.
pub const OP_SNAPSHOT: u8 = 0x03;

/// Monta `[op][tamanho do id][id][seq de 8 bytes][conteúdo]`.
///
/// O id da sessão vai por extenso, e não como um índice numérico curto: um
/// índice exigiria uma tabela sincronizada entre os dois lados, e qualquer
/// desencontro dela entregaria a saída de um terminal na tela de outro. Os
/// ~38 bytes de cabeçalho são pagos uma vez a cada lote de ~8 ms — algo como
/// 5 KB/s no pior caso, contra o risco de uma classe inteira de bug.
pub fn frame_com_seq(op: u8, session_id: &str, seq: u64, payload: &[u8]) -> Vec<u8> {
    let id = session_id.as_bytes();
    let mut out = Vec::with_capacity(1 + 1 + id.len() + 8 + payload.len());
    out.push(op);
    out.push(id.len() as u8);
    out.extend_from_slice(id);
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Lê `[op][tamanho do id][id][conteúdo]` — o formato sem `seq`, usado pela
/// entrada do convidado. Devolve `None` para qualquer quadro truncado ou com
/// tamanho de id que não cabe no que chegou: um convidado hostil não pode
/// causar leitura fora dos limites nem pânico na thread da conexão.
pub fn parse_input(frame: &[u8]) -> Option<(&str, &[u8])> {
    if frame.len() < 2 || frame[0] != OP_INPUT {
        return None;
    }
    let id_len = frame[1] as usize;
    let fim_id = 2 + id_len;
    if frame.len() < fim_id {
        return None;
    }
    let id = std::str::from_utf8(&frame[2..fim_id]).ok()?;
    Some((id, &frame[fim_id..]))
}

/* ------------------------------ modelo da sala -------------------------- */

/// O que um convidado pode fazer num terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Só acompanha a tela.
    Ro,
    /// Também digita.
    Rw,
}

impl Mode {
    pub fn pode_escrever(self) -> bool {
        matches!(self, Mode::Rw)
    }
}

/// Um terminal exposto na sala. Só o que está nesta lista existe para o
/// convidado — os outros terminais do anfitrião são invisíveis para ele.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTerminal {
    pub session_id: String,
    pub title: String,
    pub mode: Mode,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    /// Só o nome da pasta, nunca o caminho completo: dizer "JARVIS" situa o
    /// convidado sem publicar o nome de usuário do anfitrião na tela dele.
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Host,
    Guest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub id: String,
    pub name: String,
    pub color: String,
    pub role: Role,
    pub online: bool,
    pub joined_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub author_id: String,
    pub author_name: String,
    pub author_color: String,
    pub text: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomInfo {
    pub name: String,
    pub host_name: String,
    /// Sobe a cada mudança na sala. O convidado descarta o que chegar com
    /// versão menor do que a que já aplicou — sem isso, duas mudanças rápidas
    /// (compartilhar e logo mudar a permissão) poderiam ser aplicadas fora de
    /// ordem e deixar a tela dele mentindo sobre o que ele pode fazer.
    pub revision: u64,
}

/* --------------------------- mensagens de texto ------------------------- */

/// Anfitrião → convidado.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ServerMsg {
    /// Entrou. Traz tudo de uma vez para a tela do convidado nascer completa.
    #[serde(rename_all = "camelCase")]
    Welcome {
        you: Participant,
        room: RoomInfo,
        terminals: Vec<SharedTerminal>,
        participants: Vec<Participant>,
        chat: Vec<ChatMessage>,
        /// Chave para reentrar como a mesma pessoa depois de uma queda de
        /// rede, sem passar de novo pela aprovação do anfitrião.
        resume_token: String,
    },
    /// Esperando o anfitrião aprovar.
    #[serde(rename_all = "camelCase")]
    Pending { room_name: String, host_name: String },
    /// Recusado — e por quê, em português, para a tela do convidado poder
    /// dizer algo melhor do que "erro de conexão".
    Denied { reason: String },
    #[serde(rename_all = "camelCase")]
    Terminals {
        terminals: Vec<SharedTerminal>,
        revision: u64,
    },
    #[serde(rename_all = "camelCase")]
    Participants {
        participants: Vec<Participant>,
        revision: u64,
    },
    Chat { message: ChatMessage },
    #[serde(rename_all = "camelCase")]
    Exit { session_id: String, exit_code: i32 },
    /// O terminal do anfitrião mudou de tamanho: o convidado reflete, para as
    /// duas telas continuarem idênticas caractere a caractere.
    #[serde(rename_all = "camelCase")]
    Size { session_id: String, cols: u16, rows: u16 },
    /// Um pedaço da resposta da IA, ou o começo/fim dela.
    Ai { event: AiEvent },
    /// Resposta ao `ping` do convidado — é o que alimenta o indicador de
    /// latência na tela dele.
    Pong { t0: u64 },
    /// A sala acabou.
    Bye { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "camelCase")]
pub enum AiEvent {
    /// Alguém perguntou (inclusive o próprio anfitrião).
    #[serde(rename_all = "camelCase")]
    Ask {
        request_id: String,
        author_name: String,
        author_color: String,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Chunk { request_id: String, text: String },
    #[serde(rename_all = "camelCase")]
    Done { request_id: String },
    #[serde(rename_all = "camelCase")]
    Error { request_id: String, error: String },
}

/// Convidado → anfitrião.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ClientMsg {
    #[serde(rename_all = "camelCase")]
    Hello {
        version: u32,
        code: String,
        name: String,
        /// Devolvido de um `Welcome` anterior: reentra como a mesma pessoa.
        #[serde(default)]
        resume_token: Option<String>,
    },
    Chat { text: String },
    /// Pergunta para a IA do anfitrião.
    Ai { text: String },
    /// Pede o estado atual da tela de um terminal (ao montar o painel dele).
    #[serde(rename_all = "camelCase")]
    Snapshot { session_id: String },
    Ping { t0: u64 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quadro_binario_ida_e_volta() {
        let f = frame_com_seq(OP_DATA, "sessao-1", 42, b"ola");
        assert_eq!(f[0], OP_DATA);
        assert_eq!(f[1] as usize, "sessao-1".len());
        let fim_id = 2 + "sessao-1".len();
        assert_eq!(&f[2..fim_id], b"sessao-1");
        assert_eq!(
            u64::from_be_bytes(f[fim_id..fim_id + 8].try_into().unwrap()),
            42
        );
        assert_eq!(&f[fim_id + 8..], b"ola");
    }

    #[test]
    fn entrada_do_convidado_e_lida_de_volta() {
        let mut f = vec![OP_INPUT, 3];
        f.extend_from_slice(b"abc");
        f.extend_from_slice(b"ls\r");
        assert_eq!(parse_input(&f), Some(("abc", &b"ls\r"[..])));
    }

    #[test]
    fn quadro_malformado_nao_derruba_a_conexao() {
        // Tamanho de id maior do que o quadro: o caso que um convidado
        // hostil montaria à mão para tentar ler memória vizinha.
        assert_eq!(parse_input(&[OP_INPUT, 200, b'a']), None);
        assert_eq!(parse_input(&[OP_INPUT]), None);
        assert_eq!(parse_input(&[]), None);
        // Opcode que não é de entrada não vira entrada.
        assert_eq!(parse_input(&[OP_DATA, 1, b'a', b'x']), None);
        // Id que não é UTF-8 válido.
        assert_eq!(parse_input(&[OP_INPUT, 1, 0xff, b'x']), None);
    }

    #[test]
    fn entrada_sem_conteudo_e_valida_mas_vazia() {
        let mut f = vec![OP_INPUT, 1];
        f.push(b'a');
        assert_eq!(parse_input(&f), Some(("a", &b""[..])));
    }
}
