//! Testes da camada de configuração.
//!
//! LIMITE IMPORTANTE, declarado em vez de disfarçado: `ConfigManager` guarda
//! o caminho em `config_path()`, que é fixo em `%APPDATA%/JARVIS/config.json`
//! e não é injetável. Chamar `ConfigManager::new()` ou `save_patch()` aqui
//! leria e **sobrescreveria o config real do usuário** — inclusive a chave de
//! API. Então esta suíte não instancia o `ConfigManager`.
//!
//! O que dá para testar de verdade, e é o que está aqui: a camada serde
//! (`AppConfig`/`ConfigPatch`), que é o contrato com o front e com os arquivos
//! antigos, incluindo um round-trip real em disco num diretório temporário.
//! `AppConfig::apply` é privado, então o merge em si continua coberto só pelos
//! testes internos do módulo.

use std::fs;
use std::path::PathBuf;

use jarvis_lib::config::{AiProvider, AppConfig, ConfigPatch, WorkspaceConfig};

fn dir_temp(nome: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("jarvis-qa-{nome}-{}", std::process::id()));
    fs::create_dir_all(&d).unwrap();
    d
}

/* ------------------------- round-trip em disco ------------------------- */

#[test]
fn round_trip_real_em_disco_preserva_tudo() {
    let dir = dir_temp("roundtrip");
    let arquivo = dir.join("config.json");

    let original = AppConfig {
        workspaces: vec![WorkspaceConfig {
            id: "w1".into(),
            name: "projeto ção".into(),
            path: r"C:\Users\Alan\Videos\JARVIS".into(),
            color: "#5eead4".into(),
            default_profile_id: Some("pwsh".into()),
            auto_command: Some("claude".into()),
            claude_account_id: Some("acc-pessoal".into()),
            created_at: 1_754_000_000_000,
        }],
        active_workspace_id: Some("w1".into()),
        ai: jarvis_lib::config::AiConfig {
            provider: AiProvider::Anthropic,
            api_key: "sk-ant-xyz".into(),
            model: "claude-opus-5".into(),
            temperature: 0.35,
            max_tokens: 8192,
            endpoint: "https://api.anthropic.com".into(),
        },
        ui: jarvis_lib::config::UiConfig {
            sidebar_open: true,
            ai_panel_open: false,
            theme: "dark".into(),
            density: "cozy".into(),
        },
        layout: Some(serde_json::json!({"tipo":"split","filhos":[1,2]})),
        session_history: None,
        claude_accounts: vec![jarvis_lib::config::ClaudeAccountConfig {
            id: "acc-pessoal".into(),
            name: "Pessoal".into(),
            color: "#a78bfa".into(),
            created_at: 1_754_000_000_001,
        }],
        default_claude_account_id: Some("acc-pessoal".into()),
    };

    fs::write(&arquivo, serde_json::to_string_pretty(&original).unwrap()).unwrap();
    let lido: AppConfig = serde_json::from_str(&fs::read_to_string(&arquivo).unwrap()).unwrap();

    assert_eq!(lido.workspaces.len(), 1);
    assert_eq!(lido.workspaces[0].name, "projeto ção", "acentos sobrevivem ao disco");
    assert_eq!(lido.workspaces[0].path, r"C:\Users\Alan\Videos\JARVIS");
    assert_eq!(lido.workspaces[0].created_at, 1_754_000_000_000);
    assert_eq!(lido.workspaces[0].default_profile_id.as_deref(), Some("pwsh"));
    assert_eq!(lido.workspaces[0].auto_command.as_deref(), Some("claude"));
    assert_eq!(lido.active_workspace_id.as_deref(), Some("w1"));
    // A conta é o que decide qual login o terminal daquele projeto usa; se
    // ela não sobrevivesse ao disco, todo reinício do app jogaria os
    // workspaces de volta para a conta padrão sem avisar ninguém.
    assert_eq!(lido.workspaces[0].claude_account_id.as_deref(), Some("acc-pessoal"));
    assert_eq!(lido.claude_accounts.len(), 1);
    assert_eq!(lido.claude_accounts[0].name, "Pessoal");
    assert_eq!(lido.default_claude_account_id.as_deref(), Some("acc-pessoal"));
    assert_eq!(lido.ai.provider, AiProvider::Anthropic);
    assert_eq!(lido.ai.temperature, 0.35);
    assert_eq!(lido.ai.max_tokens, 8192);
    assert!(lido.ui.sidebar_open && !lido.ui.ai_panel_open);
    assert_eq!(lido.layout, original.layout);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn as_chaves_gravadas_sao_camel_case_como_o_front_espera() {
    let cfg = AppConfig {
        active_workspace_id: Some("w".into()),
        workspaces: vec![WorkspaceConfig {
            id: "w".into(),
            name: "n".into(),
            path: "p".into(),
            color: "#fff".into(),
            default_profile_id: None,
            auto_command: None,
            claude_account_id: None,
            created_at: 7,
        }],
        ..Default::default()
    };
    let json = serde_json::to_string(&cfg).unwrap();
    for chave in [
        "activeWorkspaceId",
        "defaultProfileId",
        "createdAt",
        "sidebarOpen",
        "aiPanelOpen",
        "maxTokens",
        "apiKey",
    ] {
        assert!(json.contains(chave), "faltou `{chave}` no JSON: {json}");
    }
    // Nada de snake_case escapando para o contrato com o front.
    for errado in ["active_workspace_id", "max_tokens", "api_key"] {
        assert!(!json.contains(errado), "vazou snake_case `{errado}`: {json}");
    }
}

/* -------------------------- patch: null vs ausente --------------------- */

#[test]
fn null_explicito_difere_de_campo_ausente_no_patch() {
    let ausente: ConfigPatch = serde_json::from_str(r#"{"ui":{"sidebarOpen":true}}"#).unwrap();
    assert!(
        ausente.active_workspace_id.is_none(),
        "campo ausente = não mexi nisso"
    );

    let nulo: ConfigPatch = serde_json::from_str(r#"{"activeWorkspaceId":null}"#).unwrap();
    assert_eq!(
        nulo.active_workspace_id,
        Some(None),
        "null explícito = o front pediu modo livre"
    );

    let posto: ConfigPatch = serde_json::from_str(r#"{"activeWorkspaceId":"w9"}"#).unwrap();
    assert_eq!(posto.active_workspace_id, Some(Some("w9".into())));
}

#[test]
fn patch_vazio_nao_pede_nada() {
    let p: ConfigPatch = serde_json::from_str("{}").unwrap();
    assert!(p.workspaces.is_none());
    assert!(p.active_workspace_id.is_none());
    assert!(p.ai.is_none());
    assert!(p.ui.is_none());
    assert!(p.layout.is_none());
}

#[test]
fn patch_de_ui_pela_metade_nao_afirma_nada_sobre_o_outro_campo() {
    let p: ConfigPatch = serde_json::from_str(r#"{"ui":{"aiPanelOpen":true}}"#).unwrap();
    let ui = p.ui.expect("bloco ui presente");
    assert_eq!(ui.ai_panel_open, Some(true));
    assert!(
        ui.sidebar_open.is_none(),
        "campo não mencionado não pode virar `false`"
    );
}

/* ------------------------ compatibilidade de versão -------------------- */

#[test]
fn config_de_versao_futura_com_campos_desconhecidos_ainda_carrega() {
    let futuro = r##"{
        "workspaces":[{"id":"a","name":"n","path":"/p","color":"#fff","createdAt":5,"tema":"escuro"}],
        "activeWorkspaceId":"a",
        "ui":{"sidebarOpen":true,"algoNovo":42},
        "recursoQueAindaNaoExiste":{"x":1}
    }"##;
    let cfg: AppConfig = serde_json::from_str(futuro).expect("downgrade não pode perder tudo");
    assert_eq!(cfg.workspaces.len(), 1);
    assert_eq!(cfg.active_workspace_id.as_deref(), Some("a"));
    assert!(cfg.ui.sidebar_open);
}

#[test]
fn json_invalido_nao_e_engolido_em_silencio() {
    // Vale para o `load_from_disk`, que propaga esse erro em vez de cair no
    // default — é o que dispara o backup `.quebrado-*.json`.
    let truncado = r#"{"workspaces":[{"id":"a","#;
    let e = serde_json::from_str::<AppConfig>(truncado).expect_err("tem que ser erro");
    assert!(!e.to_string().is_empty());

    assert!(serde_json::from_str::<AppConfig>("").is_err());
    assert!(serde_json::from_str::<AppConfig>("null").is_err());
}

#[test]
fn provedor_desconhecido_nao_derruba_o_config_inteiro() {
    // Regressão: um `provider` que esta versão não conhece (escrito por uma
    // versão futura, num downgrade — ou "openrouter" adicionado depois) fazia
    // a leitura inteira falhar, o `ConfigManager` arquivar o arquivo como
    // `.quebrado-*.json` e subir do zero — o usuário perdia os workspaces.
    // Agora cai no provedor padrão e preserva o resto do documento.
    let json = r##"{
        "workspaces":[{"id":"a","name":"meu projeto","path":"/p","color":"#fff"}],
        "ai":{"provider":"openrouter","model":"algum"}
    }"##;
    let cfg: AppConfig = serde_json::from_str(json).expect("deve carregar mesmo com provider desconhecido");
    assert_eq!(cfg.workspaces.len(), 1, "os workspaces não podem ser perdidos");
    assert_eq!(cfg.ai.provider, AiProvider::Ollama, "cai no padrão");
    assert_eq!(cfg.ai.model, "algum", "o resto do bloco de IA é preservado");
}

#[test]
fn workspace_sem_campo_obrigatorio_e_descartado_sem_apagar_os_outros() {
    // Regressão: um único workspace malformado (bug de escrita, edição
    // manual) apagava a lista inteira em vez de descartar só a entrada ruim.
    let json = r#"{"workspaces":[{"id":"a","name":"bom","path":"/p"},{"id":"b","name":"sem path"}]}"#;
    let cfg: AppConfig = serde_json::from_str(json).expect("deve carregar mesmo com um workspace malformado");
    assert_eq!(cfg.workspaces.len(), 1);
    assert_eq!(cfg.workspaces[0].id, "a");
}

/* ------------------------------- limites ------------------------------- */

#[test]
fn temperatura_e_max_tokens_absurdos_atravessam_sem_validacao() {
    // Caracterização: não há clamp em lugar nenhum. Se um dia houver
    // validação, este teste avisa.
    let json = r#"{"ai":{"temperature":999.0,"maxTokens":4294967295}}"#;
    let cfg: AppConfig = serde_json::from_str(json).unwrap();
    assert_eq!(cfg.ai.temperature, 999.0);
    assert_eq!(cfg.ai.max_tokens, u32::MAX);

    // Negativo em `maxTokens` (u32) é recusado, e isso é bom.
    assert!(serde_json::from_str::<AppConfig>(r#"{"ai":{"maxTokens":-1}}"#).is_err());
}

#[test]
fn layout_opaco_atravessa_qualquer_forma_sem_ser_interpretado() {
    let dir = dir_temp("layout");
    let arquivo = dir.join("c.json");
    let esquisito = serde_json::json!({
        "profundo": [[[{"a": [1, 2, {"b": null}]}]]],
        "unicode": "├─ ção 🖥"
    });
    let cfg = AppConfig {
        layout: Some(esquisito.clone()),
        ..Default::default()
    };
    fs::write(&arquivo, serde_json::to_string(&cfg).unwrap()).unwrap();
    let lido: AppConfig = serde_json::from_str(&fs::read_to_string(&arquivo).unwrap()).unwrap();
    assert_eq!(lido.layout, Some(esquisito));
    let _ = fs::remove_dir_all(&dir);
}
