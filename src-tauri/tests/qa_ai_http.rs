//! Testes do cliente de IA contra um servidor HTTP de mentira.
//!
//! Estes testes sobem um `TcpListener` numa thread e falam HTTP na unha, então
//! exercitam o `reqwest` de verdade — cabeçalhos, corpo, status, erro de
//! conexão — sem depender de rede externa nem de chave de ninguém.
//!
//! Cobre o que dá para alcançar de fora: `AiManager::list_models` é o único
//! caminho público que atravessa `descreve_http`, `descreve_rede`,
//! `redige_segredos` e `extrai_modelos` sem precisar de um `AppHandle`.
//! (`chat_stream` precisa de um `AppHandle` de verdade; ver o relatório.)

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;

use jarvis_lib::ai::AiManager;
use jarvis_lib::config::{AiConfig, AiProvider};

/* -------------------------------- apoio -------------------------------- */

/// O que o servidor de mentira viu chegar.
struct Pedido {
    linha_inicial: String,
    cabecalhos: String,
}

impl Pedido {
    fn tem_cabecalho(&self, nome: &str, valor: &str) -> bool {
        self.cabecalhos
            .lines()
            .any(|l| l.to_ascii_lowercase().starts_with(&nome.to_ascii_lowercase()) && l.contains(valor))
    }
}

/// Sobe um servidor que atende exatamente um pedido e responde o que foi
/// mandado. Devolve o endpoint e um canal com o pedido recebido.
fn servidor(status: u16, motivo: &str, corpo: &str) -> (String, mpsc::Receiver<Pedido>) {
    let corpo = corpo.to_string();
    let motivo = motivo.to_string();
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let porta = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let Ok((mut sock, _)) = listener.accept() else {
            return;
        };
        let pedido = le_pedido(&mut sock);
        let resposta = format!(
            "HTTP/1.1 {status} {motivo}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{corpo}",
            corpo.len()
        );
        let _ = sock.write_all(resposta.as_bytes());
        let _ = sock.flush();
        let _ = tx.send(pedido);
    });

    (format!("http://127.0.0.1:{porta}"), rx)
}

fn le_pedido(sock: &mut TcpStream) -> Pedido {
    let mut cru = Vec::new();
    let mut b = [0u8; 1024];
    // Só os cabeçalhos interessam; paramos na linha em branco.
    while !cru.windows(4).any(|w| w == b"\r\n\r\n") {
        match sock.read(&mut b) {
            Ok(0) | Err(_) => break,
            Ok(n) => cru.extend_from_slice(&b[..n]),
        }
    }
    let texto = String::from_utf8_lossy(&cru).to_string();
    let mut linhas = texto.lines();
    Pedido {
        linha_inicial: linhas.next().unwrap_or_default().to_string(),
        cabecalhos: linhas.collect::<Vec<_>>().join("\n"),
    }
}

fn cfg(provider: AiProvider, endpoint: &str, api_key: &str) -> AiConfig {
    AiConfig {
        provider,
        endpoint: endpoint.to_string(),
        api_key: api_key.to_string(),
        model: "modelo-x".into(),
        ..AiConfig::default()
    }
}

fn roda<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

fn erro_de_list_models(config: AiConfig) -> String {
    roda(AiManager::new().list_models(config))
        .expect_err("devia ter falhado")
        .to_string()
}

/* ---------------------- mapeamento de status HTTP ---------------------- */

#[test]
fn status_401_vira_chave_recusada_em_portugues() {
    let (url, _rx) = servidor(
        401,
        "Unauthorized",
        r#"{"error":{"message":"invalid api key"}}"#,
    );
    let msg = erro_de_list_models(cfg(AiProvider::OpenAi, &url, "sk-teste"));
    assert!(msg.contains("chave de API recusada"), "{msg}");
    assert!(msg.contains("401"), "{msg}");
    assert!(msg.contains("invalid api key"), "detalhe do provedor preservado: {msg}");
}

#[test]
fn status_404_vira_modelo_ou_endpoint_nao_encontrado() {
    let (url, _rx) = servidor(404, "Not Found", r#"{"error":{"message":"no such model"}}"#);
    let msg = erro_de_list_models(cfg(AiProvider::Anthropic, &url, "k"));
    assert!(msg.contains("modelo ou endpoint não encontrado"), "{msg}");
    assert!(msg.contains("no such model"), "{msg}");
}

#[test]
fn status_429_vira_limite_de_uso() {
    let (url, _rx) = servidor(429, "Too Many Requests", r#"{"error":{"message":"rate limit"}}"#);
    let msg = erro_de_list_models(cfg(AiProvider::Gemini, &url, "k"));
    assert!(msg.contains("limite de uso atingido"), "{msg}");
}

#[test]
fn erro_do_ollama_com_campo_error_string_e_lido() {
    // O Ollama manda `{"error":"..."}` puro, sem o objeto aninhado dos outros.
    let (url, _rx) = servidor(404, "Not Found", r#"{"error":"model 'x' not found"}"#);
    let msg = erro_de_list_models(cfg(AiProvider::Ollama, &url, ""));
    assert!(msg.contains("model 'x' not found"), "{msg}");
}

#[test]
fn corpo_de_erro_gigante_e_nao_json_nao_inunda_a_tela() {
    // Um proxy corporativo devolvendo uma página HTML de erro.
    let html = "<html>".to_string() + &"x".repeat(50_000) + "</html>";
    let (url, _rx) = servidor(500, "Internal Server Error", &html);
    let msg = erro_de_list_models(cfg(AiProvider::OpenAi, &url, "k"));
    assert!(msg.contains("500"), "{msg}");
    assert!(
        msg.chars().count() < 300,
        "corpo cru foi truncado, e não despejado inteiro ({} chars)",
        msg.chars().count()
    );
}

/* ----------------------- autenticação e formato ------------------------ */

#[test]
fn a_chave_do_gemini_vai_em_cabecalho_e_nunca_na_url() {
    let (url, rx) = servidor(200, "OK", r#"{"models":[{"name":"models/gemini-2.5-flash"}]}"#);
    let modelos = roda(AiManager::new().list_models(cfg(AiProvider::Gemini, &url, "AIza-SEGREDO")))
        .expect("200 devia listar");
    // O prefixo `models/` do Google é removido no caminho real, não só no unitário.
    assert_eq!(modelos, vec!["gemini-2.5-flash"]);

    let p = rx.recv().unwrap();
    assert!(
        !p.linha_inicial.contains("AIza-SEGREDO"),
        "a chave apareceu na linha de pedido (ela vai parar em log de proxy): {}",
        p.linha_inicial
    );
    assert!(
        p.tem_cabecalho("x-goog-api-key", "AIza-SEGREDO"),
        "cabeçalhos: {}",
        p.cabecalhos
    );
}

#[test]
fn openai_manda_bearer_e_anthropic_manda_x_api_key() {
    let (url, rx) = servidor(200, "OK", r#"{"data":[{"id":"gpt-x"}]}"#);
    let m = roda(AiManager::new().list_models(cfg(AiProvider::OpenAi, &url, "sk-abc"))).unwrap();
    assert_eq!(m, vec!["gpt-x"]);
    assert!(rx.recv().unwrap().tem_cabecalho("authorization", "Bearer sk-abc"));

    let (url, rx) = servidor(200, "OK", r#"{"data":[{"id":"claude-x"}]}"#);
    let m = roda(AiManager::new().list_models(cfg(AiProvider::Anthropic, &url, "ant-abc"))).unwrap();
    assert_eq!(m, vec!["claude-x"]);
    let p = rx.recv().unwrap();
    assert!(p.tem_cabecalho("x-api-key", "ant-abc"), "{}", p.cabecalhos);
    assert!(
        p.tem_cabecalho("anthropic-version", "2023-06-01"),
        "sem a versão a Anthropic recusa o pedido: {}",
        p.cabecalhos
    );
}

#[test]
fn barra_sobrando_no_endpoint_nao_vira_barra_dupla() {
    let (url, rx) = servidor(200, "OK", r#"{"data":[]}"#);
    let com_barra = format!("{url}///");
    let _ = roda(AiManager::new().list_models(cfg(AiProvider::OpenAi, &com_barra, "k")));
    let p = rx.recv().unwrap();
    assert!(p.linha_inicial.contains("/v1/models"), "{}", p.linha_inicial);
    assert!(!p.linha_inicial.contains("//v1"), "{}", p.linha_inicial);
}

#[test]
fn resposta_200_com_json_de_forma_inesperada_devolve_lista_vazia_sem_panicar() {
    // Provedor que muda o formato: nada de panicar por indexar campo ausente.
    let (url, _rx) = servidor(200, "OK", r#"{"objeto":"ao inves de lista"}"#);
    let m = roda(AiManager::new().list_models(cfg(AiProvider::OpenAi, &url, "k"))).unwrap();
    assert!(m.is_empty());
}

/* ------------------------------ segredos ------------------------------- */

#[test]
fn chave_em_query_string_dentro_do_corpo_de_erro_e_redigida() {
    // O provedor devolve, no texto do erro, a URL completa que recebeu.
    let corpo = r#"{"error":{"message":"bad request for /v1beta/models?alt=sse&key=AIza-SEGREDO&x=1 and retry key=AIza-SEGREDO"}}"#;
    let (url, _rx) = servidor(400, "Bad Request", corpo);
    let msg = erro_de_list_models(cfg(AiProvider::Gemini, &url, "AIza-SEGREDO"));
    assert!(!msg.contains("AIza-SEGREDO"), "chave vazou na mensagem: {msg}");
    assert_eq!(msg.matches("key=<oculta>").count(), 2, "as duas ocorrências: {msg}");
}

#[test]
fn chave_no_fim_da_mensagem_sem_separador_e_redigida() {
    let (url, _rx) = servidor(
        400,
        "Bad Request",
        r#"{"error":{"message":"falhou com key=AIza-NO-FIM"}}"#,
    );
    let msg = erro_de_list_models(cfg(AiProvider::Gemini, &url, "AIza-NO-FIM"));
    assert!(!msg.contains("AIza-NO-FIM"), "chave vazou no fim da string: {msg}");
}

#[test]
fn chave_na_query_string_do_endpoint_nao_vaza_no_erro_de_conexao() {
    // Regressão: `descreve_rede` interpolava o endpoint cru na mensagem de
    // erro de conexão sem passar por `redige_segredos`. Um usuário que cole
    // no campo de endpoint a URL da documentação do Google (que inclui
    // `?key=...`) via a própria chave no balão de erro do chat.
    let porta_morta = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        drop(l);
        p
    };
    let endpoint = format!("http://127.0.0.1:{porta_morta}/?key=AIza-DO-ENDPOINT");
    let msg = erro_de_list_models(cfg(AiProvider::Gemini, &endpoint, "AIza-DO-ENDPOINT"));

    assert!(msg.contains("não consegui conectar"), "{msg}");
    assert!(!msg.contains("AIza-DO-ENDPOINT"), "a chave vazou: {msg}");
    assert!(msg.contains("key=<oculta>"), "{msg}");
}

#[test]
fn conexao_recusada_vira_pergunta_util_em_portugues() {
    let porta_morta = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        drop(l);
        p
    };
    let msg = erro_de_list_models(cfg(
        AiProvider::Ollama,
        &format!("http://127.0.0.1:{porta_morta}"),
        "",
    ));
    assert!(msg.contains("não consegui conectar"), "{msg}");
    assert!(msg.contains("o serviço está no ar?"), "{msg}");
    // Erro cru do reqwest não vaza para a tela.
    assert!(!msg.contains("error sending request"), "{msg}");
}
