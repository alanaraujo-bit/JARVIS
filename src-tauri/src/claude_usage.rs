//! Leitura local do uso do Claude Code (a CLI `claude`), sem chamar nenhuma
//! API — tudo sai de arquivos que a própria CLI já grava em `~/.claude`.
//!
//! Não existe, no disco, nem custo pré-calculado nem timestamp de reset de
//! limite: só tokens por evento. O custo aqui é uma ESTIMATIVA nossa (tabela
//! de preço por modelo, ver `preco_por_milhao`), não um valor oficial da
//! Anthropic — pode divergir de plano pra plano (assinatura fixa x uso
//! avulso) e fica velho se os preços mudarem.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{JarvisError, Result};

/// Diretório de configuração a inspecionar.
///
/// `None` significa a configuração principal (`~/.claude`), que é a conta de
/// quem nunca criou conta nenhuma no JARVIS. Com contas, cada uma tem a sua
/// pasta e o mesmo código serve às duas situações — o formato dos arquivos
/// que a CLI escreve é idêntico, mude o diretório que mudar.
fn claude_dir(config_dir: Option<&str>) -> Option<PathBuf> {
    match config_dir {
        Some(d) if !d.trim().is_empty() => Some(PathBuf::from(d)),
        _ => dirs::home_dir().map(|h| h.join(".claude")),
    }
}

/* ------------------------------ settings.json ---------------------------- */

/// Só os dois campos que o JARVIS lê/escreve; qualquer outra chave do
/// arquivo é preservada como está (`write_settings` faz merge, não
/// substitui o arquivo inteiro).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettings {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort_level: Option<String>,
}

pub fn read_settings(config_dir: Option<&str>) -> ClaudeSettings {
    let Some(dir) = claude_dir(config_dir) else {
        return ClaudeSettings::default();
    };
    let Ok(content) = fs::read_to_string(dir.join("settings.json")) else {
        return ClaudeSettings::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

/// Grava `model`/`effortLevel` por cima do `settings.json` existente, sem
/// apagar as outras chaves que a própria CLI usa (tema, flags, etc.) — ler o
/// arquivo inteiro como `ClaudeSettings` e regravar perderia tudo que não
/// está tipado aqui.
pub fn write_settings(
    config_dir: Option<&str>,
    model: Option<String>,
    effort_level: Option<String>,
) -> Result<()> {
    let dir =
        claude_dir(config_dir).ok_or_else(|| JarvisError::ConfigIo("sem diretório home".into()))?;
    fs::create_dir_all(&dir).map_err(|e| JarvisError::ConfigIo(e.to_string()))?;
    let path = dir.join("settings.json");

    let mut value: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let obj = value
        .as_object_mut()
        .ok_or_else(|| JarvisError::ConfigIo("settings.json do Claude Code não é um objeto".into()))?;
    // `trim` + rejeitar vazio aqui também, não só no front: este é o ponto
    // que de fato toca o arquivo que a CLI lê, e nada garante que todo
    // chamador futuro deste comando passe por aquele formulário.
    if let Some(m) = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()) {
        obj.insert("model".into(), serde_json::Value::String(m));
    }
    if let Some(e) = effort_level.map(|e| e.trim().to_string()).filter(|e| !e.is_empty()) {
        obj.insert("effortLevel".into(), serde_json::Value::String(e));
    }

    let content = serde_json::to_string_pretty(&value).map_err(|e| JarvisError::ConfigIo(e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|e| JarvisError::ConfigIo(e.to_string()))?;
    fs::rename(&tmp, &path).map_err(|e| JarvisError::ConfigIo(e.to_string()))?;
    Ok(())
}

/* --------------------------------- uso ------------------------------------ */

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub current_model: Option<String>,
    pub current_effort: Option<String>,
    pub by_model: Vec<ModelUsage>,
    /// Tokens (entrada+saída, sem cache) somados nas últimas 5h/24h — a
    /// aproximação mais próxima que dá pra fazer da janela de limite da
    /// Anthropic sem um timestamp de reset, que não fica salvo localmente.
    pub tokens_last5h: u64,
    pub tokens_last24h: u64,
    pub cost_last5h_usd: f64,
    pub cost_total_usd: f64,
    pub total_events: u64,
    /// `true` quando nada em `~/.claude/projects` pôde ser lido — front deve
    /// mostrar "sem dados" em vez de zero, que pareceria "zero uso".
    pub no_data: bool,
}

/// Preço aproximado (USD por milhão de tokens): (entrada, saída, escrita de
/// cache, leitura de cache). Cotações públicas da Anthropic, arredondadas;
/// servem só pra dar uma ORDEM DE GRANDEZA de custo, não um extrato fiel.
fn preco_por_milhao(model: &str) -> (f64, f64, f64, f64) {
    let m = model.to_lowercase();
    if m.contains("opus") {
        (15.0, 75.0, 18.75, 1.5)
    } else if m.contains("haiku") {
        (0.8, 4.0, 1.0, 0.08)
    } else {
        // Sonnet e qualquer modelo não reconhecido caem no preço "do meio".
        (3.0, 15.0, 3.75, 0.3)
    }
}

fn custo_usd(model: &str, input: u64, output: u64, cache_write: u64, cache_read: u64) -> f64 {
    let (pi, po, pcw, pcr) = preco_por_milhao(model);
    (input as f64 / 1_000_000.0) * pi
        + (output as f64 / 1_000_000.0) * po
        + (cache_write as f64 / 1_000_000.0) * pcw
        + (cache_read as f64 / 1_000_000.0) * pcr
}

/// Varre `~/.claude/projects/*/*.jsonl` somando o campo `usage` de cada
/// linha de resposta do assistente. Cada linha é um evento JSON isolado
/// (formato "JSON Lines"); linhas que não parseiam ou não têm `usage` são
/// puladas silenciosamente — o arquivo é escrito por outro processo (a CLI)
/// e pode estar sendo gravado no exato momento da leitura.
pub fn summarize_usage(config_dir: Option<&str>) -> UsageSummary {
    let settings = read_settings(config_dir);
    let mut resumo = UsageSummary {
        current_model: settings.model,
        current_effort: settings.effort_level,
        ..Default::default()
    };

    let Some(projects_dir) = claude_dir(config_dir).map(|d| d.join("projects")) else {
        resumo.no_data = true;
        return resumo;
    };
    let Ok(top) = fs::read_dir(&projects_dir) else {
        resumo.no_data = true;
        return resumo;
    };

    let agora_ms = now_ms();
    let corte_5h = agora_ms.saturating_sub(5 * 3_600_000);
    let corte_24h = agora_ms.saturating_sub(24 * 3_600_000);

    let mut por_modelo: HashMap<String, ModelUsage> = HashMap::new();
    let mut arquivos_lidos = 0u32;
    // O Claude Code grava uma linha JSONL por BLOCO de conteúdo do turno
    // (thinking, texto, cada tool_use) — todas as linhas do mesmo turno
    // repetem o mesmo `usage` do turno inteiro. Sem deduplicar por
    // `message.id`, um turno com 3 blocos soma o mesmo custo/tokens 3 vezes;
    // medido num transcript real daqui, isso inflava o total em ~1.85x.
    let mut mensagens_vistas: std::collections::HashSet<String> = std::collections::HashSet::new();

    for proj in top.flatten() {
        let Ok(ft) = proj.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(proj.path()) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            arquivos_lidos += 1;

            for (idx, linha) in content.lines().enumerate() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(linha) else {
                    continue;
                };
                let usage = v.get("usage").or_else(|| v.get("message").and_then(|m| m.get("usage")));
                let Some(usage) = usage else { continue };

                // Chave de dedup: o id da mensagem quando existe (o caso normal);
                // sem ele, cai para "arquivo:linha" — único por natureza, então
                // nunca deduplica por engano linhas de turnos diferentes.
                let msg_id = v
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(|id| id.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("{}:{idx}", path.display()));
                if !mensagens_vistas.insert(msg_id) {
                    continue;
                }

                let model = v
                    .get("model")
                    .or_else(|| v.get("message").and_then(|m| m.get("model")))
                    .and_then(|m| m.as_str())
                    .unwrap_or("desconhecido")
                    .to_string();

                let input = campo_u64(usage, "input_tokens");
                let output = campo_u64(usage, "output_tokens");
                let cache_w = campo_u64(usage, "cache_creation_input_tokens");
                let cache_r = campo_u64(usage, "cache_read_input_tokens");
                if input == 0 && output == 0 && cache_w == 0 && cache_r == 0 {
                    continue;
                }

                let entry = por_modelo.entry(model.clone()).or_insert_with(|| ModelUsage {
                    model: model.clone(),
                    ..Default::default()
                });
                entry.input_tokens += input;
                entry.output_tokens += output;
                entry.cache_creation_tokens += cache_w;
                entry.cache_read_tokens += cache_r;
                entry.cost_usd += custo_usd(&model, input, output, cache_w, cache_r);

                resumo.total_events += 1;
                resumo.cost_total_usd += custo_usd(&model, input, output, cache_w, cache_r);

                let ts = v
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .and_then(parse_rfc3339_ms);
                if let Some(ts) = ts {
                    let tokens = input + output;
                    if ts >= corte_24h {
                        resumo.tokens_last24h += tokens;
                    }
                    if ts >= corte_5h {
                        resumo.tokens_last5h += tokens;
                        resumo.cost_last5h_usd += custo_usd(&model, input, output, cache_w, cache_r);
                    }
                }
            }
        }
    }

    resumo.no_data = arquivos_lidos == 0;
    resumo.by_model = por_modelo.into_values().collect();
    resumo.by_model.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));
    resumo
}

/// Uso de uma conta, para o painel poder pôr as três lado a lado.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub account_id: String,
    pub summary: UsageSummary,
}

/// Resume várias contas de uma vez.
///
/// Sequencial e não paralelo: são poucas contas, e a varredura é dominada
/// por I/O de arquivos pequenos no mesmo disco — threads aqui competiriam
/// pelo mesmo recurso para ganhar milissegundos. O comando que chama isto já
/// é `async`, então a janela não trava enquanto roda.
pub fn summarize_accounts(contas: &[(String, String)]) -> Vec<AccountUsage> {
    contas
        .iter()
        .map(|(id, dir)| AccountUsage {
            account_id: id.clone(),
            summary: summarize_usage(Some(dir)),
        })
        .collect()
}

fn campo_u64(v: &serde_json::Value, campo: &str) -> u64 {
    v.get(campo).and_then(|x| x.as_u64()).unwrap_or(0)
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parser mínimo de timestamp UTC no formato que o Claude Code grava
/// (`AAAA-MM-DDTHH:MM:SS(.fff)?Z`). Não puxamos uma crate de datas só por
/// isto: o formato é fixo e sempre em UTC (sufixo `Z`).
fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    let s = s.trim().strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut dp = date.split('-');
    let year: i64 = dp.next()?.parse().ok()?;
    let month: i64 = dp.next()?.parse().ok()?;
    let day: i64 = dp.next()?.parse().ok()?;

    let (time_main, millis) = match time.split_once('.') {
        Some((main, frac)) => {
            let frac3 = format!("{:0<3}", &frac[..frac.len().min(3)]);
            (main, frac3.parse::<i64>().unwrap_or(0))
        }
        None => (time, 0),
    };
    let mut tp = time_main.split(':');
    let hour: i64 = tp.next()?.parse().ok()?;
    let min: i64 = tp.next()?.parse().ok()?;
    let sec: i64 = tp.next()?.parse().ok()?;

    let days = days_from_civil(year, month, day);
    let ms = days * 86_400_000 + hour * 3_600_000 + min * 60_000 + sec * 1000 + millis;
    u64::try_from(ms).ok()
}

/// Versão do parser que aceita também offset numérico (`+00:00`, `-03:00`),
/// como a Anthropic devolve em `resets_at` — a base só conhece o `Z` que a
/// CLI grava localmente. O offset é aplicado ao epoch, então quem chamar
/// recebe sempre milissegundos UTC.
pub(crate) fn parse_rfc3339_ms_com_offset(s: &str) -> Option<u64> {
    let s = s.trim();
    // Offset: `Z` (UTC) ou ±HH:MM no fim. O último sinal depois do 'T' é o
    // do offset; um sinal antes disso pertence à data e a string não tem
    // offset (aceitamos por tolerância, tratando como UTC).
    let (corpo, desloc_min) = if let Some(c) = s.strip_suffix('Z') {
        (c, 0i64)
    } else {
        let t_pos = s.find('T')?;
        let sinal = s.rfind(|c| c == '+' || c == '-')?;
        if sinal < t_pos {
            (s, 0i64)
        } else {
            let (hh, mm) = s[sinal + 1..].split_once(':')?;
            let hh: i64 = hh.parse().ok()?;
            let mm: i64 = mm.parse().ok()?;
            let dir = if s.as_bytes().get(sinal) == Some(&b'-') { -1 } else { 1 };
            (&s[..sinal], dir * (hh * 60 + mm))
        }
    };
    // A base exige o sufixo `Z`; reconstituí-lo é o jeito de reusar o parser
    // já testado em vez de duplicar a aritmética de data aqui. O ajuste do
    // offset roda em i128 para os sinais não brigarem: `-03:00` soma 3h ao
    // UTC, `+05:00` subtrai.
    let base = parse_rfc3339_ms(&format!("{corpo}Z"))?;
    let offset_ms = desloc_min.saturating_mul(60_000);
    u64::try_from(base as i128 - offset_ms as i128).ok()
}

/// Algoritmo civil-de-Hinnant (dias desde a época Unix a partir de
/// ano/mês/dia gregoriano). Correto para qualquer data >= 0000-03-01.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_timestamp_com_e_sem_milissegundos() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00.500Z"), Some(500));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(parse_rfc3339_ms("2026-01-01T00:00:00Z"), Some(1_767_225_600_000));
    }

    #[test]
    fn parse_timestamp_com_offset_numerico() {
        // O mesmo instante escrito com `Z` e com offset +00:00.
        let z = parse_rfc3339_ms_com_offset("2026-03-10T04:59:59.5Z").unwrap();
        assert_eq!(
            parse_rfc3339_ms_com_offset("2026-03-10T04:59:59.500000+00:00"),
            Some(z)
        );
        // -03:00 adianta 3h em relação ao UTC.
        assert_eq!(
            parse_rfc3339_ms_com_offset("2026-03-10T01:59:59.5-03:00"),
            Some(z)
        );
        // O offset não pode virar um número negativo de epoch.
        assert!(parse_rfc3339_ms_com_offset("1970-01-01T00:00:00+00:00").is_some());
    }

    #[test]
    fn preco_reflete_a_familia_do_modelo() {
        assert!(preco_por_milhao("claude-opus-5").0 > preco_por_milhao("claude-sonnet-5").0);
        assert!(preco_por_milhao("claude-sonnet-5").0 > preco_por_milhao("claude-haiku-4-5").0);
    }

    #[test]
    fn evento_sem_usage_e_ignorado_sem_quebrar_a_varredura() {
        let v: serde_json::Value = serde_json::json!({"type": "mode"});
        assert!(v.get("usage").is_none());
    }
}
