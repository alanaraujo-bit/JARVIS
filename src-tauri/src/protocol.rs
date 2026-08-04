use serde::{Deserialize, Serialize};

/// Nomes de evento emitidos para o front. Centralizados para não divergirem
/// das constantes espelhadas em `src/lib/ipc.ts`.
pub const EV_EXIT: &str = "pty:exit";

/// Evento de dados é por sessão (`pty:data:<id>`), para o WebView não pagar
/// fan-out de payload em todas as janelas de terminal abertas. Ser um evento
/// (e não um canal ponto a ponto) é proposital: nas etapas de splits, dois
/// painéis podem exibir a mesma sessão e os dois precisam receber a saída.
pub fn ev_data(id: &str) -> String {
    format!("pty:data:{id}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// Programa a executar. Se ausente, usa o shell padrão do sistema.
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    /// Diretório de trabalho inicial (a "pasta" ligada ao terminal).
    #[serde(default)]
    pub cwd: Option<String>,
    /// Variáveis extras, sobrepostas ao ambiente herdado.
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// Rótulo exibido na aba.
    #[serde(default)]
    pub title: Option<String>,
    /// Identificador do perfil de shell usado (para estatísticas).
    #[serde(default)]
    pub profile_id: Option<String>,
}

fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub profile_id: Option<String>,
    pub pid: Option<u32>,
    /// Epoch em milissegundos.
    pub started_at: u64,
    pub alive: bool,
    pub exit_code: Option<i32>,
    /// Contadores para o painel de estatísticas (etapa 5). Custam um `fetch_add`
    /// no caminho quente e evitam ter que reformar o motor depois.
    pub bytes_out: u64,
    pub bytes_in: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitEvent {
    pub id: String,
    pub exit_code: i32,
    pub ended_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataEvent {
    pub id: String,
    /// Bytes crus do PTY em base64 — evita corromper UTF-8 partido entre chunks.
    pub b64: String,
    /// Total acumulado de bytes da sessão até o fim deste lote.
    pub seq: u64,
}

/// Estado da tela para uma aba que está sendo (re)montada.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub bytes: Vec<u8>,
    pub seq: u64,
}

/// Versão serializável do instantâneo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPayload {
    pub b64: String,
    /// Posição no fluxo em que este instantâneo termina. O front descarta os
    /// eventos que chegaram antes disso, o que elimina a corrida entre pedir o
    /// histórico e assinar o fluxo ao vivo.
    pub seq: u64,
}

/// Perfil de shell detectado na máquina.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub icon: String,
    /// Perfil sugerido como padrão (melhor shell disponível).
    pub recommended: bool,
}
