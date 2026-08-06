//! Configuração persistida em disco (`%APPDATA%/JARVIS/config.json`).
//!
//! O front é dono da forma dos dados; este módulo é o guardião do arquivo.
//! Duas decisões moldam tudo aqui:
//!
//! 1. **Todo campo tem `#[serde(default)]`.** Um config.json escrito por uma
//!    versão anterior — ou por uma versão *futura*, num downgrade — precisa
//!    carregar. Sem isso, acrescentar um campo obrigatório faria a leitura
//!    falhar inteira e o usuário perderia workspaces e chaves de API.
//!
//! 2. **A escrita é um merge, não uma substituição.** O painel de IA e a
//!    barra de workspaces salvam de forma independente e concorrente. Se
//!    cada um mandasse o config inteiro, o último a gravar apagaria o que o
//!    outro acabou de mudar — o clássico read-modify-write perdido. Cada um
//!    manda só a sua fatia (`ConfigPatch`, campos `Option`) e o merge
//!    acontece aqui, sob um mutex.

use crate::error::{JarvisError, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Provedores suportados. `lowercase` (e não `camelCase`) é deliberado: o
/// espelho em TypeScript usa `"openai"`, não `"openAi"`, e um `camelCase`
/// aqui rejeitaria silenciosamente todo config que escolhesse a OpenAI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Ollama,
    #[serde(rename = "openai")]
    OpenAi,
    Anthropic,
    Gemini,
}

/// Lê o provedor sem derrubar o arquivo inteiro se o valor for desconhecido.
///
/// `#[serde(default)]` cobre o campo **ausente**, não o campo presente com um
/// valor que esta versão não conhece. Sem esta tolerância, um único
/// `"provider":"openrouter"` — escrito por uma versão mais nova, num
/// downgrade — fazia a leitura falhar inteira, o arquivo ser arquivado como
/// `.quebrado-*.json` e o app subir do zero: o usuário perdia workspaces,
/// arranjo de painéis e a chave de API por causa de uma palavra.
fn provider_tolerante<'de, D>(d: D) -> std::result::Result<AiProvider, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Passa por `Value` para tolerar até um tipo inesperado (número, objeto)
    // no lugar da string.
    let bruto = serde_json::Value::deserialize(d)?;
    Ok(match bruto.as_str() {
        Some("ollama") => AiProvider::Ollama,
        Some("openai") => AiProvider::OpenAi,
        Some("anthropic") => AiProvider::Anthropic,
        Some("gemini") => AiProvider::Gemini,
        outro => {
            if let Some(nome) = outro {
                eprintln!("[jarvis] provedor de IA desconhecido ({nome}); usando o padrão");
            }
            default_provider()
        }
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    #[serde(default = "default_provider", deserialize_with = "provider_tolerante")]
    pub provider: AiProvider,
    #[serde(default = "default_endpoint")]
    pub endpoint: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
}

fn default_provider() -> AiProvider {
    AiProvider::Ollama
}
fn default_endpoint() -> String {
    "http://localhost:11434".to_string()
}
fn default_model() -> String {
    "llama3".to_string()
}
fn default_temperature() -> f32 {
    0.7
}
fn default_max_tokens() -> u32 {
    2048
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            endpoint: default_endpoint(),
            api_key: String::new(),
            model: default_model(),
            temperature: default_temperature(),
            max_tokens: default_max_tokens(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub default_profile_id: Option<String>,
    /// Comando digitado automaticamente ao abrir um terminal neste workspace
    /// (ex.: "claude"). `None`/vazio desliga o auto-início.
    #[serde(default)]
    pub auto_command: Option<String>,
    /// Conta do Claude Code usada nos terminais deste projeto. `None` = a
    /// conta padrão do app. Um id que não existe mais na lista de contas é
    /// tratado como `None` pelo front, e não como erro: apagar uma conta não
    /// pode inutilizar os workspaces que a usavam.
    #[serde(default)]
    pub claude_account_id: Option<String>,
    /// Epoch em milissegundos. `u64` e não `i64`: o front sempre manda
    /// `Date.now()`, que nunca é negativo.
    #[serde(default)]
    pub created_at: u64,
}

/// Uma conta do Claude Code registrada no JARVIS.
///
/// O que mora aqui é só o rótulo: o estado real (logada? qual plano?) vem do
/// disco, em `claude_accounts::status`. Guardar "logada" no config seria
/// guardar uma cópia que envelhece — a pessoa pode deslogar pela própria CLI,
/// fora do app, e o config nunca ficaria sabendo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountConfig {
    pub id: String,
    pub name: String,
    #[serde(default = "default_account_color")]
    pub color: String,
    #[serde(default)]
    pub created_at: u64,
}

fn default_account_color() -> String {
    "#a78bfa".to_string()
}

fn default_color() -> String {
    "#5eead4".to_string()
}

/// Preferências de interface que sobrevivem ao fechamento do app.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiConfig {
    #[serde(default)]
    pub sidebar_open: bool,
    #[serde(default)]
    pub ai_panel_open: bool,
    /// `"system" | "dark" | "light"`. String livre de propósito: um valor
    /// desconhecido escrito por uma versão futura não pode derrubar o parse
    /// do arquivo inteiro — o front trata o que não reconhece como
    /// `"system"`.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Densidade da interface: `"compact" | "cozy"`.
    #[serde(default = "default_density")]
    pub density: String,
    /// `true` quando a pessoa já viu a introdução de primeira execução.
    /// A flag mora aqui, e não no front, porque é a única forma de ela
    /// sobreviver a um F5 sem depender de mais um localStorage.
    ///
    /// O default é `false` também para configs antigos que não têm o campo
    /// (`serde(default)`): quem atualiza para a versão com o menu novo vê a
    /// introdução uma vez — é a apresentação da navegação que mudou, não um
    /// bug de "primeira execução" reaparecendo.
    #[serde(default)]
    pub onboarding_done: bool,
}

fn default_theme() -> String {
    "system".to_string()
}

fn default_density() -> String {
    "cozy".to_string()
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            sidebar_open: false,
            ai_panel_open: false,
            theme: default_theme(),
            density: default_density(),
            onboarding_done: false,
        }
    }
}

/// Descarta só as entradas malformadas, em vez de rejeitar a lista inteira.
///
/// Um workspace sem `path` (campo sem `default`, obrigatório de propósito —
/// não faz sentido um workspace sem pasta) fazia o `Vec<WorkspaceConfig>`
/// inteiro falhar o parse, e por `AppConfig` não ter fallback por campo isso
/// arrastava o config inteiro para o caminho de "arquivo ilegível": todos os
/// workspaces bons iam junto por causa de um só corrompido.
fn workspaces_tolerantes<'de, D>(d: D) -> std::result::Result<Vec<WorkspaceConfig>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let bruto = Vec::<serde_json::Value>::deserialize(d)?;
    Ok(bruto
        .into_iter()
        .filter_map(|v| match serde_json::from_value::<WorkspaceConfig>(v) {
            Ok(w) => Some(w),
            Err(e) => {
                eprintln!("[jarvis] workspace inválido no config, ignorado ({e})");
                None
            }
        })
        .collect())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default, deserialize_with = "workspaces_tolerantes")]
    pub workspaces: Vec<WorkspaceConfig>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    #[serde(default)]
    pub ai: AiConfig,
    #[serde(default)]
    pub ui: UiConfig,
    /// Arranjo de abas e divisões, guardado como JSON opaco.
    ///
    /// A forma da árvore pertence ao front e muda com a interface; tipá-la
    /// aqui obrigaria os dois lados a evoluir em passo travado sem que o
    /// backend ganhe nada — ele só precisa guardar e devolver. As folhas
    /// referenciam sessões de PTY, que não sobrevivem ao fechamento do app,
    /// então um arranjo obsoleto é descartado pelo front na leitura.
    #[serde(default)]
    pub layout: Option<serde_json::Value>,
    /// Histórico recente de sessões de terminal abertas (JSON opaco, mesma
    /// lógica do `layout`): permite ao front avisar "isso ficou aberto da
    /// última vez" quando o app fecha sem passar pelo `pty_close` de cada
    /// aba (crash, Alt+F4, encerrar pelo gerenciador de tarefas).
    #[serde(default)]
    pub session_history: Option<serde_json::Value>,
    /// Contas do Claude Code cadastradas. Mesma tolerância dos workspaces:
    /// uma entrada corrompida some sozinha em vez de derrubar o config.
    #[serde(default, deserialize_with = "contas_tolerantes")]
    pub claude_accounts: Vec<ClaudeAccountConfig>,
    /// Conta usada por terminais que não herdam nada de um workspace.
    #[serde(default)]
    pub default_claude_account_id: Option<String>,
}

/// Mesma lógica de `workspaces_tolerantes`, para a lista de contas.
fn contas_tolerantes<'de, D>(d: D) -> std::result::Result<Vec<ClaudeAccountConfig>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let bruto = Vec::<serde_json::Value>::deserialize(d)?;
    Ok(bruto
        .into_iter()
        .filter_map(|v| match serde_json::from_value::<ClaudeAccountConfig>(v) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("[jarvis] conta do Claude inválida no config, ignorada ({e})");
                None
            }
        })
        .collect())
}

/// Fatia parcial do config. Cada tela manda só o que ela é dona; um `None`
/// significa "não mexi nisso", e não "apague isso".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    #[serde(default)]
    pub workspaces: Option<Vec<WorkspaceConfig>>,
    /// Duplamente opcional de propósito: `None` = campo ausente no patch
    /// (preserva o que já estava); `Some(None)` = o front pediu o modo livre.
    #[serde(default, deserialize_with = "double_option")]
    pub active_workspace_id: Option<Option<String>>,
    #[serde(default)]
    pub ai: Option<AiConfig>,
    /// Campo a campo, e não o bloco inteiro: a barra lateral é dona de
    /// `sidebarOpen` e o painel de IA é dono de `aiPanelOpen`. Substituir o
    /// bloco faria abrir o painel de IA fechar a barra lateral.
    #[serde(default)]
    pub ui: Option<UiPatch>,
    #[serde(default)]
    pub layout: Option<serde_json::Value>,
    #[serde(default)]
    pub session_history: Option<serde_json::Value>,
    #[serde(default)]
    pub claude_accounts: Option<Vec<ClaudeAccountConfig>>,
    /// Duplamente opcional, como `active_workspace_id`: `Some(None)` é o
    /// pedido explícito de "voltar a não ter conta padrão".
    #[serde(default, deserialize_with = "double_option")]
    pub default_claude_account_id: Option<Option<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPatch {
    #[serde(default)]
    pub sidebar_open: Option<bool>,
    #[serde(default)]
    pub ai_panel_open: Option<bool>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub density: Option<String>,
    #[serde(default)]
    pub onboarding_done: Option<bool>,
}

fn double_option<'de, D>(d: D) -> std::result::Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(d).map(Some)
}

impl AppConfig {
    fn apply(&mut self, patch: ConfigPatch) {
        if let Some(w) = patch.workspaces {
            self.workspaces = w;
        }
        if let Some(a) = patch.active_workspace_id {
            self.active_workspace_id = a;
        }
        if let Some(ai) = patch.ai {
            self.ai = ai;
        }
        if let Some(l) = patch.layout {
            self.layout = Some(l);
        }
        if let Some(h) = patch.session_history {
            self.session_history = Some(h);
        }
        if let Some(c) = patch.claude_accounts {
            self.claude_accounts = c;
        }
        if let Some(d) = patch.default_claude_account_id {
            self.default_claude_account_id = d;
        }
        if let Some(ui) = patch.ui {
            if let Some(v) = ui.sidebar_open {
                self.ui.sidebar_open = v;
            }
            if let Some(v) = ui.ai_panel_open {
                self.ui.ai_panel_open = v;
            }
            if let Some(v) = ui.theme {
                self.ui.theme = v;
            }
            if let Some(v) = ui.density {
                self.ui.density = v;
            }
            if let Some(v) = ui.onboarding_done {
                self.ui.onboarding_done = v;
            }
        }
    }
}

pub struct ConfigManager {
    config: Mutex<AppConfig>,
    /// Serializa as gravações sem prender o lock do estado durante a E/S.
    escrita: Mutex<()>,
}

impl ConfigManager {
    pub fn new() -> Self {
        let config = match Self::load_from_disk() {
            Ok(c) => c,
            Err(e) => {
                // Cair no default aqui e seguir em frente destruiria os
                // dados do usuário: o primeiro save de qualquer tela — até
                // um Ctrl+Shift+I, que só alterna um painel — gravaria o
                // config vazio por cima do arquivo, levando junto os
                // workspaces e a chave de API. Guardamos o arquivo ilegível
                // ao lado para dar chance de recuperação manual.
                eprintln!("[jarvis] config ilegível ({e}); começando do zero");
                let path = Self::config_path();
                if path.exists() {
                    let backup = path.with_extension(format!(
                        "quebrado-{}.json",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0)
                    ));
                    if let Err(e) = fs::rename(&path, &backup) {
                        eprintln!("[jarvis] não consegui preservar o config quebrado: {e}");
                    } else {
                        eprintln!("[jarvis] cópia preservada em {}", backup.display());
                    }
                }
                AppConfig::default()
            }
        };
        Self {
            config: Mutex::new(config),
            escrita: Mutex::new(()),
        }
    }

    fn config_path() -> PathBuf {
        let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        path.push("JARVIS");
        path.push("config.json");
        path
    }

    fn load_from_disk() -> Result<AppConfig> {
        let path = Self::config_path();
        if !path.exists() {
            return Ok(AppConfig::default());
        }
        let content = fs::read_to_string(path).map_err(|e| JarvisError::ConfigIo(e.to_string()))?;
        serde_json::from_str(&content).map_err(|e| JarvisError::ConfigIo(e.to_string()))
    }

    /// Devolve o estado em memória. Não relê o disco: o processo é o único
    /// escritor do arquivo, então a memória é a versão mais nova por
    /// construção — e reler abriria uma janela para devolver um estado
    /// anterior a uma gravação ainda em curso de outra tela.
    pub fn load(&self) -> AppConfig {
        self.config.lock().clone()
    }

    /// Aplica a fatia e grava.
    ///
    /// O merge acontece sob o lock; a escrita, fora dele. Duas telas salvando
    /// ao mesmo tempo continuam vendo um estado consistente, e nenhuma fica
    /// presa atrás da E/S de disco da outra. A escrita em si é serializada
    /// pelo lock próprio do arquivo.
    pub fn save_patch(&self, patch: ConfigPatch) -> Result<AppConfig> {
        let snapshot = {
            let mut guard = self.config.lock();
            guard.apply(patch);
            guard.clone()
        };
        let _escrita = self.escrita.lock();
        Self::write_to_disk(&snapshot)?;
        Ok(snapshot)
    }

    fn write_to_disk(config: &AppConfig) -> Result<()> {
        use std::io::Write as _;

        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| JarvisError::ConfigIo(e.to_string()))?;
        }
        let content = serde_json::to_string_pretty(config)
            .map_err(|e| JarvisError::ConfigIo(e.to_string()))?;

        // Escreve num temporário e renomeia: uma queda no meio da gravação
        // deixaria um JSON truncado, e o app abriria sem workspaces nem
        // chave de API na próxima vez. O rename é atômico no NTFS.
        let tmp = path.with_extension("json.tmp");
        let escreve = || -> std::io::Result<()> {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(content.as_bytes())?;
            // Sem isto o rename pode chegar ao journal antes dos dados: o
            // arquivo final existiria, vazio, exatamente no cenário de queda
            // de energia que o temporário deveria cobrir.
            f.sync_all()?;
            Ok(())
        };

        if let Err(e) = escreve().and_then(|_| fs::rename(&tmp, &path)) {
            // Um temporário abandonado guarda a chave de API em texto puro.
            let _ = fs::remove_file(&tmp);
            return Err(JarvisError::ConfigIo(e.to_string()));
        }
        Ok(())
    }

    pub fn ai(&self) -> AiConfig {
        self.config.lock().ai.clone()
    }
}

impl Default for ConfigManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provedor_openai_serializa_como_o_front_espera() {
        let json = serde_json::to_string(&AiProvider::OpenAi).unwrap();
        assert_eq!(json, "\"openai\"");
        let back: AiProvider = serde_json::from_str("\"openai\"").unwrap();
        assert_eq!(back, AiProvider::OpenAi);
    }

    #[test]
    fn config_de_versao_antiga_ainda_carrega() {
        // Sem `ui`, sem `activeWorkspaceId`, workspace sem `createdAt`.
        let antigo = r##"{"workspaces":[{"id":"a","name":"n","path":"/p","color":"#fff"}]}"##;
        let cfg: AppConfig = serde_json::from_str(antigo).unwrap();
        assert_eq!(cfg.workspaces.len(), 1);
        assert_eq!(cfg.workspaces[0].created_at, 0);
        assert_eq!(cfg.ai.provider, AiProvider::Ollama);
        assert!(!cfg.ui.sidebar_open);
    }

    #[test]
    fn patch_de_uma_tela_nao_apaga_a_fatia_da_outra() {
        let mut cfg = AppConfig::default();
        cfg.apply(ConfigPatch {
            workspaces: Some(vec![WorkspaceConfig {
                id: "w1".into(),
                name: "proj".into(),
                path: "C:/p".into(),
                color: "#fff".into(),
                default_profile_id: None,
                auto_command: None,
                claude_account_id: None,
                created_at: 1,
            }]),
            ..Default::default()
        });

        // O painel de IA salva só a fatia dele.
        let patch_ia: ConfigPatch =
            serde_json::from_str(r#"{"ai":{"provider":"anthropic","model":"claude-opus-5"}}"#)
                .unwrap();
        cfg.apply(patch_ia);

        assert_eq!(cfg.workspaces.len(), 1, "workspaces sobreviveram ao save da IA");
        assert_eq!(cfg.ai.provider, AiProvider::Anthropic);
        assert_eq!(cfg.ai.model, "claude-opus-5");
    }

    #[test]
    fn abrir_o_painel_de_ia_nao_fecha_a_barra_lateral() {
        // Regressão: `ui` era substituído em bloco, e o painel de IA (que só
        // conhece o próprio campo) zerava o da barra lateral.
        let mut cfg = AppConfig::default();
        let barra: ConfigPatch = serde_json::from_str(r#"{"ui":{"sidebarOpen":true}}"#).unwrap();
        cfg.apply(barra);
        let painel: ConfigPatch = serde_json::from_str(r#"{"ui":{"aiPanelOpen":true}}"#).unwrap();
        cfg.apply(painel);

        assert!(cfg.ui.sidebar_open, "a barra lateral continua aberta");
        assert!(cfg.ui.ai_panel_open);
    }

    #[test]
    fn modo_livre_e_distinguivel_de_campo_ausente() {
        let mut cfg = AppConfig {
            active_workspace_id: Some("w1".into()),
            ..Default::default()
        };

        // Patch que não menciona o workspace ativo: preserva.
        let so_ui: ConfigPatch = serde_json::from_str(r#"{"ui":{"sidebarOpen":true}}"#).unwrap();
        cfg.apply(so_ui);
        assert_eq!(cfg.active_workspace_id.as_deref(), Some("w1"));

        // Patch que pede modo livre explicitamente: limpa.
        let livre: ConfigPatch = serde_json::from_str(r#"{"activeWorkspaceId":null}"#).unwrap();
        cfg.apply(livre);
        assert_eq!(cfg.active_workspace_id, None);
    }
}
