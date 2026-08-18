//! Cota real do Claude Code (a CLI `claude`), consultada na Anthropic.
//!
//! A estimativa local de `claude_usage` só conhece tokens — não existe no
//! disco um timestamp de reset. O `/usage` da CLI resolve isso consultando
//! `GET https://api.anthropic.com/api/oauth/usage` com o token OAuth salvo
//! em `.credentials.json`; este módulo faz a mesma chamada e devolve o uso
//! real das janelas de 5h e de 7 dias, com o momento exato em que cada uma
//! zera.
//!
//! O token nunca atravessa o IPC: é lido aqui, usado na requisição e
//! descartado — o que vai para o front são só percentuais e timestamps.
//! Qualquer falha (offline, token expirado, plano sem essas janelas) vira
//! `available: false` com uma mensagem amigável, e o painel cai para a
//! estimativa local.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::claude_usage::parse_rfc3339_ms_com_offset;

/// Endpoint que a própria CLI consulta para o `/usage`.
const URL_USAGE: &str = "https://api.anthropic.com/api/oauth/usage";
/// Cabeçalho beta exigido pelo endpoint.
const BETA_USAGE: &str = "oauth-2025-04-20";
/// A Anthropic coloca requisições sem User-Agent de CLI num bucket de
/// rate-limit agressivo (429) — imitar o formato da CLI evita esse balde.
const USER_AGENT: &str = "claude-code/2.1.4";
/// Uma consulta que demore mais que isto não vale a espera: a cota é um
/// dado de apoio, não o caminho crítico do app.
const TIMEOUT: Duration = Duration::from_secs(8);

/// Mesma resolução de diretório do `claude_usage`: `None` = `~/.claude`.
fn claude_dir(config_dir: Option<&str>) -> Option<PathBuf> {
    match config_dir {
        Some(d) if !d.trim().is_empty() => Some(PathBuf::from(d)),
        _ => dirs::home_dir().map(|h| h.join(".claude")),
    }
}

/// Uma janela de cota da resposta da Anthropic.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowUsage {
    /// Percentual da janela já consumido (0–100).
    pub utilization_pct: f64,
    /// Epoch em ms em que a janela zera.
    pub resets_at_ms: u64,
}

/// Gasto extra além da assinatura, quando o plano permite.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraUsage {
    pub is_enabled: bool,
    pub monthly_limit: Option<f64>,
    pub used_credits: Option<f64>,
    pub utilization: Option<f64>,
}

/// Cota real de uma configuração. `available: false` não é um erro do app —
/// é o sinal de que não há como saber a cota agora (sem login, offline,
/// plano sem essas janelas) e o front deve mostrar a estimativa local.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveUsage {
    pub available: bool,
    /// Mensagem amigável quando `available == false`.
    pub error: Option<String>,
    pub five_hour: Option<WindowUsage>,
    pub seven_day: Option<WindowUsage>,
    pub extra_usage: Option<ExtraUsage>,
}

/// Cota ao vivo de uma conta, para o painel pôr as contas lado a lado.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLiveUsage {
    pub account_id: String,
    pub usage: LiveUsage,
}

/// Lê o token de acesso OAuth de `.credentials.json` — o mesmo arquivo que
/// a CLI usa. Os campos de credencial são declarados só aqui, e nunca são
/// serializados para o front.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OauthCredenciais {
    #[serde(default)]
    access_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArquivoCredenciais {
    #[serde(default)]
    claude_ai_oauth: Option<OauthCredenciais>,
}

fn token_oauth(config_dir: Option<&str>) -> Option<String> {
    let dir = claude_dir(config_dir)?;
    let conteudo = fs::read_to_string(dir.join(".credentials.json")).ok()?;
    let arquivo: ArquivoCredenciais = serde_json::from_str(&conteudo).ok()?;
    arquivo
        .claude_ai_oauth?
        .access_token
        .filter(|t| !t.trim().is_empty())
}

fn parse_janela(v: &serde_json::Value) -> Option<WindowUsage> {
    Some(WindowUsage {
        utilization_pct: v.get("utilization")?.as_f64()?.clamp(0.0, 100.0),
        resets_at_ms: parse_rfc3339_ms_com_offset(v.get("resets_at")?.as_str()?)?,
    })
}

fn parse_resposta(corpo: &str) -> Result<LiveUsage, String> {
    let v: serde_json::Value =
        serde_json::from_str(corpo).map_err(|e| format!("resposta inesperada da Anthropic: {e}"))?;
    Ok(LiveUsage {
        available: true,
        error: None,
        five_hour: v.get("five_hour").and_then(parse_janela),
        seven_day: v.get("seven_day").and_then(parse_janela),
        // `null` (que a API devolve quando o plano não tem gasto extra) vira
        // `None` de verdade — um `Some` com tudo no default mentiria sobre a
        // forma do payload.
        extra_usage: v.get("extra_usage").and_then(|e| {
            if e.is_null() {
                None
            } else {
                Some(ExtraUsage {
                    is_enabled: e.get("is_enabled").and_then(|x| x.as_bool()).unwrap_or(false),
                    monthly_limit: e.get("monthly_limit").and_then(|x| x.as_f64()),
                    used_credits: e.get("used_credits").and_then(|x| x.as_f64()),
                    utilization: e.get("utilization").and_then(|x| x.as_f64()),
                })
            }
        }),
    })
}

async fn consultar(token: &str) -> Result<LiveUsage, String> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("falha ao preparar o cliente HTTP: {e}"))?;
    let resp = client
        .get(URL_USAGE)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", BETA_USAGE)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("sem conexão com a Anthropic — mostrando estimativa local ({e})"))?;

    let status = resp.status();
    let corpo = resp.text().await.unwrap_or_default();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(
            "sessão expirada ou inválida — rode /login no Claude Code para reconectar esta conta"
                .into(),
        );
    }
    if !status.is_success() {
        return Err(format!("a Anthropic respondeu {status} — mostrando estimativa local"));
    }
    parse_resposta(&corpo)
}

/// Cota ao vivo de uma pasta de configuração (ou da principal, com `None`).
pub async fn live_usage(config_dir: Option<&str>) -> LiveUsage {
    let Some(token) = token_oauth(config_dir) else {
        return LiveUsage {
            available: false,
            error: Some("esta conta não tem login salvo — entre nela e rode /login".into()),
            ..Default::default()
        };
    };
    match consultar(&token).await {
        Ok(u) => u,
        Err(e) => LiveUsage {
            available: false,
            error: Some(e),
            ..Default::default()
        },
    }
}

/// Cota ao vivo de várias contas de uma vez.
///
/// Sequencial de propósito: são poucas contas e cada consulta tem timeout
/// próprio; disparar N em paralelo não traria a resposta mais cedo, só
/// empilharia requisições no mesmo endpoint.
pub async fn live_for_accounts(contas: &[(String, String)]) -> Vec<AccountLiveUsage> {
    let mut out = Vec::with_capacity(contas.len());
    for (id, dir) in contas {
        out.push(AccountLiveUsage {
            account_id: id.clone(),
            usage: live_usage(Some(dir)).await,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parseia_as_janelas_da_resposta_real() {
        let corpo = r#"{
            "five_hour": {"utilization": 37.0, "resets_at": "2026-03-10T04:59:59.000000+00:00"},
            "seven_day": {"utilization": 26.0, "resets_at": "2026-03-15T14:59:59.771647+00:00"},
            "seven_day_opus": null,
            "seven_day_sonnet": {"utilization": 1.0, "resets_at": "2026-03-16T20:59:59.771655+00:00"},
            "extra_usage": {"is_enabled": false, "monthly_limit": null, "used_credits": null, "utilization": null}
        }"#;
        let u = parse_resposta(corpo).unwrap();
        assert!(u.available);
        let five = u.five_hour.unwrap();
        assert_eq!(five.utilization_pct, 37.0);
        assert!(five.resets_at_ms > 1_700_000_000_000);
        let sete = u.seven_day.unwrap();
        assert_eq!(sete.utilization_pct, 26.0);
        assert!(u.extra_usage.is_some());
    }

    #[test]
    fn resposta_sem_janelas_nao_quebra() {
        let u = parse_resposta(r#"{"seven_day_opus": null}"#).unwrap();
        assert!(u.available);
        assert!(u.five_hour.is_none());
        assert!(u.seven_day.is_none());
    }

    #[test]
    fn corpo_nao_json_vira_erro() {
        assert!(parse_resposta("não é json").is_err());
    }

    #[test]
    fn percentual_fora_da_faixa_e_amarrado() {
        let corpo = r#"{"five_hour": {"utilization": 140.0, "resets_at": "2026-01-01T00:00:00Z"}}"#;
        assert_eq!(
            parse_resposta(corpo).unwrap().five_hour.unwrap().utilization_pct,
            100.0
        );
    }

    #[test]
    fn sem_credenciais_nao_houve_requisicao() {
        // Pasta inexistente: `token_oauth` devolve `None` e `live_usage`
        // responde `available: false` sem tocar na rede.
        let u = bloco(live_usage(Some("Z:/nao/existe/mesmo")));
        assert!(!u.available);
        assert!(u.error.is_some());
    }

    /// Mini runner para os testes async, sem puxar mais uma dev-dependency.
    fn bloco<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Runtime::new().unwrap().block_on(f)
    }
}
