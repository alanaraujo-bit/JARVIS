use serde::Serialize;

/// Erro único do backend. Serializa como string para o front,
/// mas mantém a causa raiz legível no log nativo.
#[derive(Debug, thiserror::Error)]
pub enum JarvisError {
    #[error("sessão não encontrada: {0}")]
    SessionNotFound(String),

    #[error("sessão já encerrada: {0}")]
    SessionDead(String),

    #[error("falha ao abrir o PTY: {0}")]
    PtyOpen(String),

    #[error("falha ao redimensionar o terminal: {0}")]
    Resize(String),

    #[error("falha ao iniciar `{program}`: {reason}")]
    Spawn { program: String, reason: String },

    #[error("a pasta não existe: {0}")]
    BadCwd(String),

    #[error("payload inválido: {0}")]
    BadPayload(String),

    #[error("erro de E/S: {0}")]
    Io(#[from] std::io::Error),

    #[error("erro de configuração: {0}")]
    ConfigIo(String),

    #[error("erro na requisição de IA: {0}")]
    AiRequest(String),

    #[error("erro do provedor de IA: {0}")]
    AiProvider(String),
}

impl Serialize for JarvisError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, JarvisError>;
