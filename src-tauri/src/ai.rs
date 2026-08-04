//! Ponte de streaming com os provedores de IA.
//!
//! Todos os quatro provedores mandam a resposta como um fluxo de linhas —
//! NDJSON no Ollama, SSE nos outros — e é aí que mora o detalhe que exige
//! cuidado: **um chunk de HTTP não é uma linha**. O corpo chega picado por
//! tamanho de pacote, então uma linha JSON pode vir partida em dois chunks e
//! um caractere UTF-8 multibyte pode ter seus bytes divididos entre eles.
//!
//! Por isso o fluxo passa por um `LineBuffer` que acumula **bytes** e só
//! entrega linhas completas. Decodificar cada chunk isolado com
//! `from_utf8_lossy` (o caminho óbvio) produziria caracteres de substituição
//! no meio de palavras acentuadas e descartaria toda linha que atravessasse
//! a fronteira entre dois chunks.

use crate::config::{AiConfig, AiProvider};
use crate::error::{JarvisError, Result};
use crate::protocol::{
    AiChunkEvent, AiDoneEvent, AiErrorEvent, AiMessage, EV_AI_CHUNK, EV_AI_DONE, EV_AI_ERROR,
};
use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

/// Quanto tempo sem receber um único byte antes de desistir da geração.
///
/// O cliente de streaming não pode ter timeout total — uma resposta longa
/// leva minutos por natureza. Mas um provedor que aceita a conexão e para de
/// falar (Ollama travado, rede que cai sem RST) deixaria a leitura pendurada
/// para sempre, e com ela a task e o socket.
const INATIVIDADE_MAX: Duration = Duration::from_secs(120);

/// Timeout das chamadas curtas (listar modelos), onde uma demora só pode ser
/// problema.
const TIMEOUT_CURTO: Duration = Duration::from_secs(30);

/// Sinal de cancelamento de uma geração.
///
/// Um `AtomicBool` sozinho não bastaria: ele só é consultado entre um chunk
/// e o seguinte, então cancelar um fluxo que parou de enviar bytes não teria
/// efeito nenhum — a leitura seguiria pendurada e o painel ficaria travado em
/// "gerando" até o app reiniciar. O `Notify` acorda a leitura na hora.
#[derive(Default)]
pub struct Cancelamento {
    sinal: Notify,
    marcado: AtomicBool,
}

impl Cancelamento {
    pub fn cancelar(&self) {
        self.marcado.store(true, Ordering::Relaxed);
        // `notify_one` guarda a permissão se ainda não houver ninguém
        // esperando, então um cancelamento que chegue antes da leitura
        // começar não se perde.
        self.sinal.notify_one();
    }

    fn cancelado(&self) -> bool {
        self.marcado.load(Ordering::Relaxed)
    }
}

pub type CancellationToken = Arc<Cancelamento>;

/// O que uma linha do fluxo significa.
#[derive(Debug, PartialEq)]
enum Delta {
    /// Texto para acrescentar à resposta.
    Text(String),
    /// O provedor sinalizou fim de resposta.
    Done,
    /// O provedor reportou um erro no meio de uma resposta 200 (cota, filtro
    /// de conteúdo, contexto estourado). Sem tratar isso, o fluxo apenas
    /// fecharia e o usuário veria uma resposta vazia sem explicação.
    Fail(String),
    /// Keep-alive, comentário SSE, metadados — nada a fazer.
    Ignore,
}

/// Acumula bytes e devolve linhas completas, preservando UTF-8 partido entre
/// chunks. O resto (linha incompleta) fica guardado para o próximo chunk.
#[derive(Default)]
struct LineBuffer {
    buf: Vec<u8>,
}

impl LineBuffer {
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut linhas = Vec::new();
        // `\n` é seguro como delimitador mesmo em UTF-8 multibyte: nenhum
        // byte de continuação cai na faixa ASCII.
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let linha: Vec<u8> = self.buf.drain(..=pos).collect();
            linhas.push(String::from_utf8_lossy(&linha).trim_end().to_string());
        }
        linhas
    }

    /// Resto sem `\n` no fim do fluxo — alguns servidores fecham a conexão
    /// sem quebra de linha final.
    fn flush(&mut self) -> Option<String> {
        if self.buf.is_empty() {
            return None;
        }
        let linha = String::from_utf8_lossy(&self.buf).trim_end().to_string();
        self.buf.clear();
        if linha.is_empty() {
            None
        } else {
            Some(linha)
        }
    }
}

/// Extrai o payload de uma linha SSE (`data: {...}`), ignorando comentários
/// de keep-alive (`: ping`) e campos que não interessam (`event:`).
fn sse_payload(linha: &str) -> Option<&str> {
    let resto = linha.strip_prefix("data:")?.trim_start();
    if resto.is_empty() {
        None
    } else {
        Some(resto)
    }
}

fn parse_ollama(linha: &str) -> Delta {
    let Ok(json) = serde_json::from_str::<Value>(linha) else {
        return Delta::Ignore;
    };
    // A ordem importa: o lote final do Ollama traz `done: true` junto com o
    // último pedaço de conteúdo. Emitir o texto antes de encerrar evita
    // perder a última palavra da resposta.
    if let Some(t) = json["message"]["content"].as_str() {
        if !t.is_empty() {
            return Delta::Text(t.to_string());
        }
    }
    if json["done"].as_bool().unwrap_or(false) {
        return Delta::Done;
    }
    Delta::Ignore
}

fn parse_openai(linha: &str) -> Delta {
    let Some(data) = sse_payload(linha) else {
        return Delta::Ignore;
    };
    if data == "[DONE]" {
        return Delta::Done;
    }
    let Ok(json) = serde_json::from_str::<Value>(data) else {
        return Delta::Ignore;
    };
    // Erro no meio de um 200: cota, contexto estourado, filtro de conteúdo.
    if let Some(msg) = json["error"]["message"].as_str() {
        return Delta::Fail(msg.to_string());
    }
    match json["choices"][0]["delta"]["content"].as_str() {
        Some(t) if !t.is_empty() => Delta::Text(t.to_string()),
        _ => Delta::Ignore,
    }
}

fn parse_anthropic(linha: &str) -> Delta {
    let Some(data) = sse_payload(linha) else {
        return Delta::Ignore;
    };
    let Ok(json) = serde_json::from_str::<Value>(data) else {
        return Delta::Ignore;
    };
    match json["type"].as_str() {
        Some("content_block_delta") => match json["delta"]["text"].as_str() {
            Some(t) if !t.is_empty() => Delta::Text(t.to_string()),
            _ => Delta::Ignore,
        },
        Some("message_stop") => Delta::Done,
        // Erro no meio do fluxo (limite de uso, contexto estourado): o
        // cabeçalho já veio 200 e o problema só aparece aqui.
        Some("error") => Delta::Fail(
            json["error"]["message"]
                .as_str()
                .unwrap_or("erro não descrito pelo provedor")
                .to_string(),
        ),
        _ => Delta::Ignore,
    }
}

fn parse_gemini(linha: &str) -> Delta {
    let Some(data) = sse_payload(linha) else {
        return Delta::Ignore;
    };
    let Ok(json) = serde_json::from_str::<Value>(data) else {
        return Delta::Ignore;
    };
    if let Some(msg) = json["error"]["message"].as_str() {
        return Delta::Fail(msg.to_string());
    }
    // Prompt barrado antes de gerar qualquer coisa.
    if let Some(motivo) = json["promptFeedback"]["blockReason"].as_str() {
        return Delta::Fail(format!("o provedor bloqueou o pedido ({motivo})"));
    }

    // As partes de um candidato podem vir em mais de um bloco.
    if let Some(partes) = json["candidates"][0]["content"]["parts"].as_array() {
        let texto: String = partes
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .concat();
        if !texto.is_empty() {
            return Delta::Text(texto);
        }
    }

    // Resposta interrompida por outro motivo que não o fim natural: sem
    // isto o fluxo só fecharia e o usuário veria um balão vazio.
    match json["candidates"][0]["finishReason"].as_str() {
        None | Some("STOP") => Delta::Ignore,
        Some("MAX_TOKENS") => Delta::Fail("resposta truncada no limite de tokens".into()),
        Some(motivo) => Delta::Fail(format!("resposta interrompida pelo provedor ({motivo})")),
    }
}

pub struct AiManager {
    /// Para o chat: sem timeout total, porque uma geração longa leva minutos.
    /// A proteção contra travamento é o watchdog de inatividade no laço.
    client: Client,
    /// Para as chamadas curtas (listar modelos), onde demorar só pode ser
    /// problema — e onde não há nenhum botão de cancelar para o usuário.
    client_curto: Client,
}

impl AiManager {
    pub fn new() -> Self {
        let base = || Client::builder().connect_timeout(Duration::from_secs(15));
        Self {
            client: base().build().unwrap_or_default(),
            client_curto: base().timeout(TIMEOUT_CURTO).build().unwrap_or_default(),
        }
    }

    /// Roda a conversa e emite `ai:chunk:<id>` / `ai:done:<id>` /
    /// `ai:error:<id>`. Sempre termina emitindo exatamente um evento
    /// terminal: sem isso o painel ficaria com o cursor piscando para sempre.
    pub async fn chat_stream(
        &self,
        messages: Vec<AiMessage>,
        system_prompt: &str,
        config: AiConfig,
        request_id: String,
        app: AppHandle,
        cancel: CancellationToken,
    ) {
        let resultado = self
            .stream(messages, system_prompt, &config, &request_id, &app, &cancel)
            .await;

        match resultado {
            Ok(()) => {
                let _ = app.emit(
                    &format!("{EV_AI_DONE}:{request_id}"),
                    AiDoneEvent { request_id },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    &format!("{EV_AI_ERROR}:{request_id}"),
                    AiErrorEvent {
                        request_id,
                        // Última barreira: nenhuma mensagem chega à tela sem
                        // passar pela redação de segredos.
                        error: redige_segredos(&e.to_string()),
                    },
                );
            }
        }
    }

    async fn stream(
        &self,
        messages: Vec<AiMessage>,
        system_prompt: &str,
        config: &AiConfig,
        request_id: &str,
        app: &AppHandle,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let base = config.endpoint.trim_end_matches('/');
        let (req, parse): (reqwest::RequestBuilder, fn(&str) -> Delta) = match config.provider {
            AiProvider::Ollama => (
                self.client.post(format!("{base}/api/chat")).json(&json!({
                    "model": config.model,
                    "messages": with_system(system_prompt, &messages),
                    "stream": true,
                    "options": {
                        "temperature": config.temperature,
                        "num_predict": config.max_tokens,
                    }
                })),
                parse_ollama,
            ),
            AiProvider::OpenAi => (
                self.client
                    .post(format!("{base}/v1/chat/completions"))
                    .bearer_auth(&config.api_key)
                    .json(&json!({
                        "model": config.model,
                        "messages": with_system(system_prompt, &messages),
                        "stream": true,
                        "temperature": config.temperature,
                        "max_tokens": config.max_tokens,
                    })),
                parse_openai,
            ),
            AiProvider::Anthropic => (
                self.client
                    .post(format!("{base}/v1/messages"))
                    .header("x-api-key", &config.api_key)
                    .header("anthropic-version", "2023-06-01")
                    .json(&json!({
                        "model": config.model,
                        // A Anthropic recusa mensagens com role "system"
                        // dentro de `messages`; o prompt vai no campo
                        // dedicado e o histórico é filtrado.
                        "messages": sem_system(&messages),
                        "system": system_prompt,
                        "stream": true,
                        "temperature": config.temperature,
                        "max_tokens": config.max_tokens,
                    })),
                parse_anthropic,
            ),
            AiProvider::Gemini => (
                // `alt=sse` é o que torna o fluxo processável linha a linha.
                // Sem ele a API devolve um array JSON gigante entregue em
                // pedaços, e nenhum pedaço isolado faz parse.
                //
                // A chave vai em header, e não na query string que a
                // documentação do Google mostra: a URL aparece inteira nas
                // mensagens de erro do reqwest, nos logs de qualquer proxy
                // corporativo no caminho e no histórico do servidor.
                self.client
                    .post(format!(
                        "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
                        base, config.model
                    ))
                    .header("x-goog-api-key", &config.api_key)
                    .json(&json!({
                        "systemInstruction": { "parts": [{ "text": system_prompt }] },
                        "contents": gemini_contents(&messages),
                        "generationConfig": {
                            "temperature": config.temperature,
                            "maxOutputTokens": config.max_tokens,
                        }
                    })),
                parse_gemini,
            ),
        };

        let res = req
            .send()
            .await
            .map_err(|e| JarvisError::AiRequest(descreve_rede(&e, base)))?;

        // Um 4xx chega como resposta normal; sem esta checagem o corpo de
        // erro (JSON com a explicação) seria tratado como fluxo e o usuário
        // veria uma resposta vazia em vez de "chave de API recusada".
        if !res.status().is_success() {
            let status = res.status();
            let corpo = res.text().await.unwrap_or_default();
            return Err(JarvisError::AiProvider(descreve_http(status, &corpo)));
        }

        let mut fluxo = res.bytes_stream();
        let mut buffer = LineBuffer::default();

        // O futuro de cancelamento é criado uma vez e reusado a cada volta:
        // recriá-lo dentro do `select!` abriria uma janela em que o sinal
        // chega entre duas iterações e se perde.
        let cancelado = cancel.sinal.notified();
        tokio::pin!(cancelado);

        loop {
            if cancel.cancelado() {
                return Ok(());
            }

            let proximo = tokio::select! {
                // Cancelar interrompe a leitura na hora, mesmo que o
                // provedor tenha parado de enviar bytes. Só checar a flag
                // entre chunks — como era antes — não teria efeito nenhum
                // num fluxo travado: o `await` seguiria pendurado para
                // sempre e o painel ficaria preso em "gerando".
                _ = &mut cancelado => return Ok(()),
                r = tokio::time::timeout(INATIVIDADE_MAX, fluxo.next()) => r,
            };

            let chunk = match proximo {
                Err(_) => {
                    return Err(JarvisError::AiRequest(format!(
                        "o provedor ficou {}s sem responder",
                        INATIVIDADE_MAX.as_secs()
                    )))
                }
                Ok(None) => break,
                Ok(Some(c)) => c.map_err(|e| JarvisError::AiRequest(descreve_rede(&e, base)))?,
            };

            for linha in buffer.push(&chunk) {
                match parse(&linha) {
                    Delta::Text(t) => emite_chunk(app, request_id, t),
                    Delta::Done => return Ok(()),
                    Delta::Fail(msg) => return Err(JarvisError::AiProvider(msg)),
                    Delta::Ignore => {}
                }
            }
        }

        if let Some(resto) = buffer.flush() {
            match parse(&resto) {
                Delta::Text(t) => emite_chunk(app, request_id, t),
                Delta::Fail(msg) => return Err(JarvisError::AiProvider(msg)),
                _ => {}
            }
        }
        Ok(())
    }

    pub async fn list_models(&self, config: AiConfig) -> Result<Vec<String>> {
        let base = config.endpoint.trim_end_matches('/');
        let (req, campo_lista, campo_nome) = match config.provider {
            AiProvider::Ollama => (
                self.client_curto.get(format!("{base}/api/tags")),
                "models",
                "name",
            ),
            AiProvider::OpenAi => (
                self.client_curto
                    .get(format!("{base}/v1/models"))
                    .bearer_auth(&config.api_key),
                "data",
                "id",
            ),
            AiProvider::Anthropic => (
                self.client_curto
                    .get(format!("{base}/v1/models"))
                    .header("x-api-key", &config.api_key)
                    .header("anthropic-version", "2023-06-01"),
                "data",
                "id",
            ),
            AiProvider::Gemini => (
                self.client_curto
                    .get(format!("{base}/v1beta/models"))
                    .header("x-goog-api-key", &config.api_key),
                "models",
                "name",
            ),
        };

        let res = req
            .send()
            .await
            .map_err(|e| JarvisError::AiRequest(descreve_rede(&e, base)))?;
        if !res.status().is_success() {
            let status = res.status();
            let corpo = res.text().await.unwrap_or_default();
            return Err(JarvisError::AiProvider(descreve_http(status, &corpo)));
        }

        let json: Value = res
            .json()
            .await
            .map_err(|e| JarvisError::AiRequest(descreve_rede(&e, base)))?;
        Ok(extrai_modelos(&json, campo_lista, campo_nome))
    }
}

impl Default for AiManager {
    fn default() -> Self {
        Self::new()
    }
}

fn extrai_modelos(json: &Value, lista: &str, nome: &str) -> Vec<String> {
    json[lista]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m[nome].as_str())
                // O Gemini prefixa tudo com "models/"; o campo de modelo do
                // app espera o id nu.
                .map(|s| s.strip_prefix("models/").unwrap_or(s).to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn with_system(system_prompt: &str, messages: &[AiMessage]) -> Vec<Value> {
    let mut out = vec![json!({ "role": "system", "content": system_prompt })];
    out.extend(
        messages
            .iter()
            .filter(|m| m.role != "system")
            .map(|m| json!({ "role": m.role, "content": m.content })),
    );
    out
}

fn sem_system(messages: &[AiMessage]) -> Vec<Value> {
    messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect()
}

fn gemini_contents(messages: &[AiMessage]) -> Vec<Value> {
    messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            json!({
                "role": if m.role == "assistant" { "model" } else { "user" },
                "parts": [{ "text": m.content }]
            })
        })
        .collect()
}

fn emite_chunk(app: &AppHandle, request_id: &str, text: String) {
    let _ = app.emit(
        &format!("{EV_AI_CHUNK}:{request_id}"),
        AiChunkEvent {
            request_id: request_id.to_string(),
            text,
        },
    );
}

/// Erros de rede crus ("error sending request for url ...") não ajudam
/// ninguém. A causa quase sempre é uma destas duas.
fn descreve_rede(e: &reqwest::Error, endpoint: &str) -> String {
    if e.is_connect() {
        format!("não consegui conectar em {endpoint} — o serviço está no ar?")
    } else if e.is_timeout() {
        format!("{endpoint} não respondeu a tempo")
    } else {
        redige_segredos(&e.to_string())
    }
}

/// Remove a chave de API de qualquer texto antes de ele virar mensagem na
/// tela. O Gemini autentica por query string, e o erro do reqwest carrega a
/// URL inteira — sem esta limpeza a chave do usuário apareceria no balão de
/// erro do chat e em qualquer print de tela que ele mandasse pedindo ajuda.
fn redige_segredos(texto: &str) -> String {
    let mut saida = String::with_capacity(texto.len());
    let mut resto = texto;
    while let Some(i) = resto.find("key=") {
        saida.push_str(&resto[..i + 4]);
        saida.push_str("<oculta>");
        let depois = &resto[i + 4..];
        // O valor termina no próximo separador de URL ou espaço.
        let fim = depois
            .find(['&', '"', ' ', ')'])
            .unwrap_or(depois.len());
        resto = &depois[fim..];
    }
    saida.push_str(resto);
    saida
}

fn descreve_http(status: reqwest::StatusCode, corpo: &str) -> String {
    // O corpo de erro dos quatro provedores carrega a mensagem útil em
    // `error.message` (ou `error` puro, no Ollama).
    let detalhe = serde_json::from_str::<Value>(corpo)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| corpo.chars().take(200).collect());

    let detalhe = redige_segredos(&detalhe);
    match status.as_u16() {
        401 | 403 => format!("chave de API recusada ({status}): {detalhe}"),
        404 => format!("modelo ou endpoint não encontrado ({status}): {detalhe}"),
        429 => format!("limite de uso atingido ({status}): {detalhe}"),
        _ => format!("o provedor respondeu {status}: {detalhe}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linhas(buf: &mut LineBuffer, chunk: &str) -> Vec<String> {
        buf.push(chunk.as_bytes())
    }

    #[test]
    fn linha_partida_entre_dois_chunks_nao_se_perde() {
        let mut buf = LineBuffer::default();
        assert!(linhas(&mut buf, "{\"a\":").is_empty());
        assert_eq!(linhas(&mut buf, "1}\n"), vec!["{\"a\":1}"]);
    }

    #[test]
    fn utf8_multibyte_partido_entre_chunks_chega_intacto() {
        // O 'ç' ocupa dois bytes; cortamos exatamente entre eles.
        let bytes = "ção\n".as_bytes();
        let mut buf = LineBuffer::default();
        assert!(buf.push(&bytes[..2]).is_empty());
        assert_eq!(buf.push(&bytes[2..]), vec!["ção"]);
    }

    #[test]
    fn varias_linhas_num_chunk_so_saem_todas() {
        let mut buf = LineBuffer::default();
        assert_eq!(linhas(&mut buf, "a\nb\nc\n"), vec!["a", "b", "c"]);
    }

    #[test]
    fn resto_sem_quebra_final_e_recuperado_no_flush() {
        let mut buf = LineBuffer::default();
        assert!(linhas(&mut buf, "sem quebra").is_empty());
        assert_eq!(buf.flush().as_deref(), Some("sem quebra"));
        assert_eq!(buf.flush(), None);
    }

    #[test]
    fn ollama_emite_o_texto_do_lote_final_antes_de_encerrar() {
        // Regressão: tratar `done` antes do conteúdo comia a última palavra.
        assert_eq!(
            parse_ollama(r#"{"message":{"content":"fim"},"done":true}"#),
            Delta::Text("fim".into())
        );
        assert_eq!(parse_ollama(r#"{"done":true}"#), Delta::Done);
    }

    #[test]
    fn openai_reconhece_done_e_delta() {
        assert_eq!(parse_openai("data: [DONE]"), Delta::Done);
        assert_eq!(
            parse_openai(r#"data: {"choices":[{"delta":{"content":"oi"}}]}"#),
            Delta::Text("oi".into())
        );
        // O primeiro delta traz só o role, sem conteúdo.
        assert_eq!(
            parse_openai(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#),
            Delta::Ignore
        );
    }

    #[test]
    fn comentario_de_keepalive_sse_e_ignorado() {
        assert_eq!(parse_openai(": ping"), Delta::Ignore);
        assert_eq!(parse_anthropic("event: content_block_delta"), Delta::Ignore);
        assert_eq!(parse_gemini(""), Delta::Ignore);
    }

    #[test]
    fn anthropic_extrai_delta_e_para_no_message_stop() {
        assert_eq!(
            parse_anthropic(
                r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"olá"}}"#
            ),
            Delta::Text("olá".into())
        );
        assert_eq!(
            parse_anthropic(r#"data: {"type":"message_stop"}"#),
            Delta::Done
        );
    }

    #[test]
    fn gemini_le_o_formato_sse_e_junta_as_partes() {
        let linha = r#"data: {"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"}]}}]}"#;
        assert_eq!(parse_gemini(linha), Delta::Text("ab".into()));
    }

    #[test]
    fn mensagens_com_role_system_nao_vazam_para_a_anthropic() {
        let msgs = vec![
            AiMessage {
                role: "system".into(),
                content: "prompt antigo".into(),
            },
            AiMessage {
                role: "user".into(),
                content: "oi".into(),
            },
        ];
        let saida = sem_system(&msgs);
        assert_eq!(saida.len(), 1);
        assert_eq!(saida[0]["role"], "user");

        // Nos outros provedores o system entra uma vez só, no topo.
        let com = with_system("novo", &msgs);
        assert_eq!(com.len(), 2);
        assert_eq!(com[0]["content"], "novo");
        assert_eq!(com[1]["role"], "user");
    }

    #[test]
    fn gemini_traduz_assistant_para_model() {
        let msgs = vec![AiMessage {
            role: "assistant".into(),
            content: "resposta".into(),
        }];
        assert_eq!(gemini_contents(&msgs)[0]["role"], "model");
    }

    #[test]
    fn lista_de_modelos_do_gemini_perde_o_prefixo() {
        let json = json!({"models":[{"name":"models/gemini-2.5-flash"}]});
        assert_eq!(
            extrai_modelos(&json, "models", "name"),
            vec!["gemini-2.5-flash"]
        );
    }

    #[test]
    fn a_chave_de_api_nunca_sobra_numa_mensagem_de_erro() {
        // O Gemini autentica por query string; o erro do reqwest traz a URL.
        let cru = "error sending request for url (https://x/v1beta/models/g:streamGenerateContent?alt=sse&key=AIzaSy-SEGREDO): timeout";
        let limpo = redige_segredos(cru);
        assert!(!limpo.contains("AIzaSy-SEGREDO"), "{limpo}");
        assert!(limpo.contains("key=<oculta>"), "{limpo}");
        // O resto da mensagem continua útil.
        assert!(limpo.contains("timeout"), "{limpo}");
        assert!(limpo.contains("alt=sse"), "{limpo}");
    }

    #[test]
    fn texto_sem_chave_atravessa_intacto() {
        let texto = "conexão recusada em http://localhost:11434";
        assert_eq!(redige_segredos(texto), texto);
    }

    #[test]
    fn erro_http_vira_mensagem_legivel() {
        let msg = descreve_http(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"invalid x-api-key"}}"#,
        );
        assert!(msg.contains("chave de API recusada"), "{msg}");
        assert!(msg.contains("invalid x-api-key"), "{msg}");
    }
}
