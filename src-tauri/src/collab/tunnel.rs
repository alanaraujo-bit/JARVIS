//! Túnel público — o que faz a sala funcionar fora da rede local.
//!
//! Na LAN o convidado alcança `ws://<ip-da-máquina>:<porta>` e não há nada a
//! resolver. Pela internet, o computador do anfitrião está atrás de um
//! roteador que não aceita conexão de fora; abrir porta no roteador é
//! configuração manual, frágil e expõe a máquina bem além desta sala.
//!
//! A saída é uma conexão **de dentro para fora**: o `cloudflared` abre um
//! canal com a borda da Cloudflare e devolve um endereço `https://` público
//! que desemboca no nosso listener local. O TLS termina lá; aqui dentro o
//! tráfego continua em texto no localhost, que é o motivo de o servidor não
//! precisar de certificado próprio.
//!
//! O binário não vem embutido: são ~70 MB contra os 5,4 MB do JARVIS inteiro,
//! e a esmagadora maioria das sessões é na mesma casa. Ele é baixado uma vez,
//! sob pedido explícito, e fica guardado ao lado da configuração do app.

use std::path::PathBuf;
use std::process::Stdio;

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// Onde o túnel está neste instante, para a interface poder ser honesta sobre
/// o que está acontecendo em vez de mostrar um endereço que ainda não existe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum TunnelState {
    /// Sala só na rede local.
    Off,
    /// O `cloudflared` não está instalado nesta máquina.
    Missing,
    /// Baixando o `cloudflared`.
    Downloading { percent: u8 },
    /// Processo no ar, ainda sem endereço.
    Starting,
    Up { url: String },
    Error { message: String },
}

/// Endereço oficial do binário para Windows x64. É a página de "última
/// versão" do próprio projeto no GitHub, e não um espelho: um túnel é
/// exatamente o tipo de coisa cuja origem tem que ser verificável.
const URL_CLOUDFLARED: &str =
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

pub struct Tunnel {
    estado: RwLock<TunnelState>,
    processo: Mutex<Option<Child>>,
}

impl Tunnel {
    pub fn new() -> Self {
        Self {
            estado: RwLock::new(TunnelState::Off),
            processo: Mutex::new(None),
        }
    }

    pub fn state(&self) -> TunnelState {
        self.estado.read().clone()
    }

    pub fn url(&self) -> Option<String> {
        match &*self.estado.read() {
            TunnelState::Up { url } => Some(url.clone()),
            _ => None,
        }
    }

    fn set(&self, novo: TunnelState) {
        *self.estado.write() = novo;
    }

    /// Caminho do binário: primeiro o que o app baixou, depois o `PATH` do
    /// sistema — quem já usa `cloudflared` para outra coisa não precisa de uma
    /// segunda cópia.
    pub fn binario() -> Option<PathBuf> {
        let proprio = Self::caminho_proprio();
        if proprio.is_file() {
            return Some(proprio);
        }
        which::which("cloudflared").ok()
    }

    fn caminho_proprio() -> PathBuf {
        let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        p.push("JARVIS");
        p.push("bin");
        p.push(if cfg!(windows) {
            "cloudflared.exe"
        } else {
            "cloudflared"
        });
        p
    }

    pub fn disponivel() -> bool {
        Self::binario().is_some()
    }

    /// Baixa o binário. `progresso` é chamado a cada pedaço para a interface
    /// poder mostrar a barra — um arquivo de dezenas de megabytes sem retorno
    /// nenhum na tela parece um app travado.
    pub async fn baixar(
        &self,
        progresso: impl Fn(TunnelState) + Send + Sync + 'static,
    ) -> Result<PathBuf, String> {
        use futures::StreamExt;

        if !cfg!(windows) {
            return Err("O download automático só está implementado para Windows.".into());
        }
        let destino = Self::caminho_proprio();
        if let Some(dir) = destino.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("não consegui criar {dir:?}: {e}"))?;
        }

        self.set(TunnelState::Downloading { percent: 0 });
        progresso(self.state());

        let resp = reqwest::get(URL_CLOUDFLARED)
            .await
            .map_err(|e| format!("falha ao contatar o servidor de download: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("o download respondeu {}", resp.status()));
        }
        let total = resp.content_length().unwrap_or(0);

        // Grava num temporário e renomeia no fim: um download interrompido
        // não pode deixar para trás um `cloudflared.exe` pela metade, que
        // seria detectado como instalado e falharia toda vez.
        let temporario = destino.with_extension("parcial");
        let mut arquivo = tokio::fs::File::create(&temporario)
            .await
            .map_err(|e| format!("não consegui gravar o download: {e}"))?;

        let mut baixado: u64 = 0;
        let mut ultimo_aviso = 0u8;
        let mut stream = resp.bytes_stream();
        while let Some(pedaco) = stream.next().await {
            let pedaco = pedaco.map_err(|e| format!("download interrompido: {e}"))?;
            use tokio::io::AsyncWriteExt;
            arquivo
                .write_all(&pedaco)
                .await
                .map_err(|e| format!("falha ao gravar: {e}"))?;
            baixado += pedaco.len() as u64;
            if total > 0 {
                let pct = ((baixado * 100) / total).min(100) as u8;
                if pct != ultimo_aviso {
                    ultimo_aviso = pct;
                    self.set(TunnelState::Downloading { percent: pct });
                    progresso(self.state());
                }
            }
        }
        use tokio::io::AsyncWriteExt;
        arquivo
            .flush()
            .await
            .map_err(|e| format!("falha ao finalizar o arquivo: {e}"))?;
        drop(arquivo);

        tokio::fs::rename(&temporario, &destino)
            .await
            .map_err(|e| format!("não consegui concluir a instalação: {e}"))?;

        self.set(TunnelState::Off);
        progresso(self.state());
        Ok(destino)
    }

    /// Sobe o túnel apontado para a porta local. Devolve quando o endereço
    /// público existe — ou quando fica claro que não vai existir.
    pub async fn start(
        &self,
        porta: u16,
        notificar: impl Fn() + Send + Sync + 'static,
    ) -> Result<String, String> {
        self.stop();

        let Some(bin) = Self::binario() else {
            self.set(TunnelState::Missing);
            notificar();
            return Err("O cloudflared não está instalado nesta máquina.".into());
        };

        self.set(TunnelState::Starting);
        notificar();

        let mut cmd = Command::new(&bin);
        cmd.arg("tunnel")
            .arg("--no-autoupdate")
            .arg("--url")
            .arg(format!("http://127.0.0.1:{porta}"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Sem isto, cada abertura de sala pisca uma janela de console preta
        // por cima do app.
        #[cfg(windows)]
        {
            // `tokio::process::Command` expõe `creation_flags` diretamente;
            // não é o `CommandExt` da std.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut filho = cmd
            .spawn()
            .map_err(|e| format!("não consegui iniciar o cloudflared: {e}"))?;

        // O `cloudflared` anuncia a URL no stderr, não no stdout. Lemos os
        // dois porque isso já mudou entre versões dele, e depender do canal
        // certo é uma aposta que não precisa ser feita.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(32);
        if let Some(out) = filho.stdout.take() {
            vigiar(BufReader::new(out), tx.clone());
        }
        if let Some(err) = filho.stderr.take() {
            vigiar(BufReader::new(err), tx.clone());
        }
        drop(tx);
        *self.processo.lock() = Some(filho);

        // Um minuto é folgado para um túnel que costuma subir em 3 a 8
        // segundos, e curto o bastante para não deixar o botão girando para
        // sempre quando a rede do anfitrião bloqueia a saída.
        let prazo = tokio::time::Duration::from_secs(60);
        let achado = tokio::time::timeout(prazo, async {
            while let Some(linha) = rx.recv().await {
                if let Some(url) = extrair_url(&linha) {
                    return Some(url);
                }
            }
            None
        })
        .await;

        match achado {
            Ok(Some(url)) => {
                self.set(TunnelState::Up { url: url.clone() });
                notificar();
                Ok(url)
            }
            Ok(None) => {
                let msg = "O cloudflared encerrou sem publicar um endereço.".to_string();
                self.stop();
                self.set(TunnelState::Error {
                    message: msg.clone(),
                });
                notificar();
                Err(msg)
            }
            Err(_) => {
                let msg =
                    "O túnel não respondeu em 60 segundos. Verifique a conexão com a internet."
                        .to_string();
                self.stop();
                self.set(TunnelState::Error {
                    message: msg.clone(),
                });
                notificar();
                Err(msg)
            }
        }
    }

    /// Derruba o túnel. Idempotente — a sala chama isto ao fechar, e o
    /// `start` chama antes de subir outro.
    pub fn stop(&self) {
        if let Some(mut filho) = self.processo.lock().take() {
            let _ = filho.start_kill();
        }
        let estado = self.estado.read().clone();
        if matches!(estado, TunnelState::Up { .. } | TunnelState::Starting) {
            self.set(TunnelState::Off);
        }
    }
}

impl Default for Tunnel {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.stop();
    }
}

fn vigiar<R>(leitor: BufReader<R>, tx: tokio::sync::mpsc::Sender<String>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut linhas = leitor.lines();
        while let Ok(Some(linha)) = linhas.next_line().await {
            if tx.send(linha).await.is_err() {
                break;
            }
        }
    });
}

/// Encontra a URL do túnel numa linha de log.
///
/// O `cloudflared` desenha uma caixa em volta do endereço com caracteres de
/// moldura, e a linha vem com espaços e barras verticais grudados. Recortar
/// por "começa em https:// e termina no primeiro caractere que não pertence a
/// uma URL" é o que sobrevive a essa formatação — e a `trycloudflare.com` é
/// exigida de propósito, para uma URL de documentação que apareça no log não
/// ser confundida com o endereço da sala.
fn extrair_url(linha: &str) -> Option<String> {
    let inicio = linha.find("https://")?;
    let resto = &linha[inicio..];
    let fim = resto
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"' || c == '\u{2502}')
        .unwrap_or(resto.len());
    let url = resto[..fim].trim_end_matches(['.', ',', ')']);
    if url.ends_with("trycloudflare.com") {
        Some(url.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acha_a_url_dentro_da_caixa_desenhada_pelo_cloudflared() {
        let linha = "2024-01-01T00:00:00Z INF |  https://exemplo-teste-abc.trycloudflare.com   |";
        assert_eq!(
            extrair_url(linha).as_deref(),
            Some("https://exemplo-teste-abc.trycloudflare.com")
        );
    }

    #[test]
    fn acha_a_url_numa_linha_simples() {
        let linha = "INF +--------------------------------------+";
        assert_eq!(extrair_url(linha), None);
        let linha = "Your quick Tunnel has been created! Visit it at https://a-b-c-d.trycloudflare.com";
        assert_eq!(
            extrair_url(linha).as_deref(),
            Some("https://a-b-c-d.trycloudflare.com")
        );
    }

    #[test]
    fn url_de_documentacao_nao_e_confundida_com_a_do_tunel() {
        let linha = "INF Cannot determine default origin certificate path. See https://developers.cloudflare.com/argo-tunnel for help";
        assert_eq!(extrair_url(linha), None);
    }

    #[test]
    fn pontuacao_no_fim_da_frase_nao_entra_na_url() {
        let linha = "visit https://x-y-z.trycloudflare.com.";
        assert_eq!(
            extrair_url(linha).as_deref(),
            Some("https://x-y-z.trycloudflare.com")
        );
    }

    #[test]
    fn parar_um_tunel_que_nunca_subiu_nao_explode() {
        let t = Tunnel::new();
        assert_eq!(t.state(), TunnelState::Off);
        t.stop();
        t.stop();
        assert_eq!(t.state(), TunnelState::Off);
        assert_eq!(t.url(), None);
    }
}
