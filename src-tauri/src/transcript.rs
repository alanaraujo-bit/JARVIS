//! Gravação em disco da saída dos terminais.
//!
//! O `Scrollback` em `pty.rs` guarda os últimos 512 KiB de cada sessão **em
//! memória**, e só isso: ele existe para repintar a tela quando um painel é
//! remontado, e morre junto com o processo do app. Fechar a aba, ou fechar o
//! JARVIS, apagava para sempre tudo que tinha acontecido ali — inclusive uma
//! conversa inteira com um agente rodando no terminal.
//!
//! Este módulo grava os mesmos bytes crus num arquivo por sessão
//! (`%APPDATA%/JARVIS/sessions/<id>.log`) mais um índice com o contexto
//! (pasta, programa, workspace, quando começou e terminou). São os bytes do
//! PTY sem tratamento nenhum, com as sequências ANSI intactas: reescrever
//! isso num xterm depois reproduz cor, cursor e layout exatamente como
//! estavam, o que texto puro não faria.
//!
//! Três decisões moldam o resto:
//!
//! 1. **A escrita mora na thread de leitura do PTY.** Cada sessão já tem a
//!    sua, e ela é a única produtora dos bytes — nenhum lock novo entra no
//!    caminho quente. O `BufWriter` amortiza as chamadas ao disco e um flush
//!    por segundo limita o que uma queda de energia levaria embora.
//!
//! 2. **O arquivo tem teto.** Um `npm run dev` esquecido aberto por um dia
//!    escreve gigabytes. Ao passar de `MAX_FILE_BYTES` o arquivo é compactado
//!    guardando só a metade final — num terminal, o fim é o que interessa.
//!
//! 3. **O índice é tolerante.** Mesma postura de `config.rs`: campo faltando
//!    ou entrada corrompida não pode derrubar o histórico inteiro.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{JarvisError, Result};

/// Teto por sessão antes da compactação.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// Quanto sobra depois de compactar. Metade do teto, e não "quase tudo":
/// compactar precisa ser raro, senão o custo de reescrever o arquivo volta
/// a cada poucos KiB de saída.
const KEEP_AFTER_COMPACT: u64 = 8 * 1024 * 1024;

/// Quantas sessões o histórico guarda. Além disso, as mais antigas somem
/// junto com os arquivos delas.
const MAX_SESSIONS: usize = 120;

/// Orçamento total de disco. Sem ele, o teto por sessão multiplicado pelo
/// número de sessões daria quase 2 GB — e o app estaria comendo o disco da
/// pessoa em silêncio, o tipo de coisa que só se descobre quando o SSD
/// enche. Quando estoura, as sessões mais antigas saem primeiro.
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;

/// Intervalo entre flushes do buffer para o disco.
const FLUSH_INTERVAL: Duration = Duration::from_secs(1);

/// Teto do que uma leitura devolve ao front de uma vez. O front reescreve
/// isso num xterm; mandar 16 MiB de uma vez congelaria a janela.
pub const DEFAULT_READ_BYTES: u64 = 2 * 1024 * 1024;

fn now_ms() -> u64 {
    crate::pty::now_ms()
}

/* -------------------------------- metadados ----------------------------- */

/// Contexto de uma sessão gravada. Todo campo tem `default`: um índice
/// escrito por outra versão precisa continuar carregando.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMeta {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
    /// Comando digitado automaticamente na abertura (ex.: `claude`). É o que
    /// permite reabrir a sessão já com o agente subindo de novo.
    #[serde(default)]
    pub auto_command: Option<String>,
    #[serde(default)]
    pub started_at: u64,
    /// `None` = a gravação nunca foi encerrada (o app morreu sem passar por
    /// aqui). A leitura na abertura seguinte fecha essas pendências.
    #[serde(default)]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// O começo foi descartado por compactação.
    #[serde(default)]
    pub truncated: bool,
    /// Tamanho do arquivo. Não é persistido: vem do `stat` na hora de listar,
    /// que é a única fonte que não pode divergir do disco.
    #[serde(default, skip_deserializing)]
    pub bytes: u64,
}

/// Descarta só a entrada ilegível, não o índice inteiro.
fn entradas_tolerantes<'de, D>(d: D) -> std::result::Result<Vec<TranscriptMeta>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let bruto = Vec::<serde_json::Value>::deserialize(d)?;
    Ok(bruto
        .into_iter()
        .filter_map(|v| serde_json::from_value::<TranscriptMeta>(v).ok())
        .filter(|m| !m.id.is_empty())
        .collect())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    #[serde(default, deserialize_with = "entradas_tolerantes")]
    entries: Vec<TranscriptMeta>,
}

/// Saída gravada, pronta para o front reescrever num terminal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptData {
    /// Bytes crus do PTY em base64 — as sequências ANSI vão junto.
    pub b64: String,
    /// Tamanho total do arquivo, mesmo quando só a cauda veio.
    pub total_bytes: u64,
    /// A leitura devolveu só o fim do arquivo.
    pub truncated: bool,
}

/* ------------------------------- o depósito ----------------------------- */

pub struct TranscriptStore {
    dir: PathBuf,
    index: Mutex<Vec<TranscriptMeta>>,
    /// Serializa a gravação do índice sem prender o lock do estado durante a
    /// E/S — mesmo arranjo do `ConfigManager`.
    escrita: Mutex<()>,
}

impl TranscriptStore {
    pub fn new() -> Arc<Self> {
        let dir = Self::default_dir();
        Self::at(dir)
    }

    /// Construtor explícito, usado pelos testes para não tocar no diretório
    /// real do usuário.
    pub fn at(dir: PathBuf) -> Arc<Self> {
        if let Err(e) = fs::create_dir_all(&dir) {
            eprintln!(
                "[jarvis] não consegui criar {}: {e}; o histórico de terminais fica desligado",
                dir.display()
            );
        }
        let entries = Self::load_index(&dir);
        let store = Arc::new(Self {
            dir,
            index: Mutex::new(entries),
            escrita: Mutex::new(()),
        });
        // Sessões que a execução anterior deixou abertas nunca foram
        // encerradas por ninguém: o app morreu antes. Fechá-las com o horário
        // da última escrita do arquivo é o mais próximo da verdade que dá pra
        // reconstruir — e deixá-las "em aberto" para sempre faria a interface
        // mostrar terminais vivos que não existem mais.
        store.close_dangling();
        store.prune();
        store
    }

    fn default_dir() -> PathBuf {
        let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        dir.push("JARVIS");
        dir.push("sessions");
        dir
    }

    fn index_path(&self) -> PathBuf {
        self.dir.join("index.json")
    }

    fn log_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.log"))
    }

    fn load_index(dir: &Path) -> Vec<TranscriptMeta> {
        let path = dir.join("index.json");
        let Ok(texto) = fs::read_to_string(&path) else {
            return Vec::new();
        };
        match serde_json::from_str::<Index>(&texto) {
            Ok(i) => i.entries,
            Err(e) => {
                eprintln!("[jarvis] índice de sessões ilegível ({e}); começando um novo");
                Vec::new()
            }
        }
    }

    /// Grava o índice. Temporário + rename, pelo mesmo motivo do config: uma
    /// queda no meio da escrita deixaria um JSON truncado e o histórico
    /// inteiro sumiria na próxima abertura.
    fn save_index(&self, entries: &[TranscriptMeta]) {
        let _guarda = self.escrita.lock();
        let path = self.index_path();
        let tmp = path.with_extension("json.tmp");
        let doc = Index {
            entries: entries.to_vec(),
        };
        let Ok(texto) = serde_json::to_string(&doc) else {
            return;
        };
        let escreve = || -> std::io::Result<()> {
            let mut f = File::create(&tmp)?;
            f.write_all(texto.as_bytes())?;
            f.sync_all()?;
            Ok(())
        };
        if let Err(e) = escreve().and_then(|_| fs::rename(&tmp, &path)) {
            let _ = fs::remove_file(&tmp);
            eprintln!("[jarvis] não consegui gravar o índice de sessões: {e}");
        }
    }

    /// Fecha as entradas que ficaram penduradas de uma execução anterior.
    fn close_dangling(&self) {
        let mut mudou = false;
        let snapshot = {
            let mut idx = self.index.lock();
            for e in idx.iter_mut() {
                if e.ended_at.is_some() {
                    continue;
                }
                mudou = true;
                e.ended_at = Some(
                    fs::metadata(self.dir.join(format!("{}.log", e.id)))
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or_else(now_ms),
                );
            }
            idx.clone()
        };
        if mudou {
            self.save_index(&snapshot);
        }
    }

    /// Abre a gravação de uma sessão nova. `None` quando o disco não
    /// colabora: gravar histórico nunca pode impedir o terminal de abrir.
    pub fn begin(self: &Arc<Self>, meta: TranscriptMeta) -> Option<TranscriptWriter> {
        let path = self.log_path(&meta.id);
        let file = match OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
        {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[jarvis] sem histórico para esta sessão ({e})");
                return None;
            }
        };

        let snapshot = {
            let mut idx = self.index.lock();
            idx.retain(|m| m.id != meta.id);
            idx.push(meta.clone());
            idx.clone()
        };
        self.save_index(&snapshot);
        self.prune();

        Some(TranscriptWriter {
            id: meta.id,
            path,
            store: Arc::clone(self),
            file: Some(std::io::BufWriter::with_capacity(64 * 1024, file)),
            escritos: 0,
            ultimo_flush: Instant::now(),
        })
    }

    /// Marca a sessão como encerrada. Idempotente: o `ended_at` que já existe
    /// vence, porque ele é o do encerramento de verdade e este pode ser o
    /// desligamento do app passando por cima.
    pub fn finish(&self, id: &str, exit_code: Option<i32>) {
        let mut mudou = false;
        let snapshot = {
            let mut idx = self.index.lock();
            for e in idx.iter_mut().filter(|e| e.id == id) {
                if e.ended_at.is_none() {
                    e.ended_at = Some(now_ms());
                    mudou = true;
                }
                if e.exit_code.is_none() && exit_code.is_some() {
                    e.exit_code = exit_code;
                    mudou = true;
                }
            }
            idx.clone()
        };
        if mudou {
            self.save_index(&snapshot);
        }
    }

    /// Encerra tudo que ficou aberto — chamado no desligamento do app.
    pub fn finish_all(&self) {
        let mut mudou = false;
        let snapshot = {
            let mut idx = self.index.lock();
            let agora = now_ms();
            for e in idx.iter_mut().filter(|e| e.ended_at.is_none()) {
                e.ended_at = Some(agora);
                mudou = true;
            }
            idx.clone()
        };
        if mudou {
            self.save_index(&snapshot);
        }
    }

    fn mark_truncated(&self, id: &str) {
        let snapshot = {
            let mut idx = self.index.lock();
            let mut mudou = false;
            for e in idx.iter_mut().filter(|e| e.id == id && !e.truncated) {
                e.truncated = true;
                mudou = true;
            }
            if !mudou {
                return;
            }
            idx.clone()
        };
        self.save_index(&snapshot);
    }

    /// Histórico do mais recente para o mais antigo, com o tamanho lido do
    /// disco. Sessões que não produziram byte nenhum e já terminaram ficam de
    /// fora: uma aba aberta e fechada sem uso não é memória de nada.
    pub fn list(&self) -> Vec<TranscriptMeta> {
        let mut out: Vec<TranscriptMeta> = self
            .index
            .lock()
            .iter()
            .map(|m| {
                let mut m = m.clone();
                m.bytes = fs::metadata(self.log_path(&m.id)).map(|f| f.len()).unwrap_or(0);
                m
            })
            .filter(|m| m.bytes > 0 || m.ended_at.is_none())
            .collect();
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }

    /// Lê a cauda da gravação. `max_bytes` é um teto de transporte, não de
    /// armazenamento: o arquivo continua inteiro no disco.
    pub fn read(&self, id: &str, max_bytes: Option<u64>) -> Result<(Vec<u8>, u64, bool)> {
        let path = self.log_path(id);
        let mut f = File::open(&path).map_err(|_| JarvisError::SessionNotFound(id.to_string()))?;
        let total = f.metadata()?.len();
        let teto = max_bytes.unwrap_or(DEFAULT_READ_BYTES).max(4096);

        if total <= teto {
            let mut buf = Vec::with_capacity(total as usize);
            f.read_to_end(&mut buf)?;
            return Ok((buf, total, false));
        }

        f.seek(SeekFrom::Start(total - teto))?;
        let mut buf = Vec::with_capacity(teto as usize);
        f.read_to_end(&mut buf)?;
        Ok((buf, total, true))
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let snapshot = {
            let mut idx = self.index.lock();
            idx.retain(|m| m.id != id);
            idx.clone()
        };
        self.save_index(&snapshot);
        // O arquivo pode não existir (índice à frente do disco); só um erro
        // de verdade sobe.
        match fs::remove_file(self.log_path(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(JarvisError::Io(e)),
        }
    }

    /// Apaga o histórico inteiro. Só o que este módulo criou: varre o índice,
    /// e não o diretório — um `remove_dir_all` numa pasta que o usuário
    /// tenha apontado para outro lugar apagaria o que não é nosso.
    pub fn clear(&self) -> Result<()> {
        let antigos: Vec<String> = {
            let mut idx = self.index.lock();
            let ids = idx.iter().map(|m| m.id.clone()).collect();
            idx.clear();
            ids
        };
        self.save_index(&[]);
        for id in antigos {
            let _ = fs::remove_file(self.log_path(&id));
        }
        Ok(())
    }

    /// Mantém o histórico dentro de `MAX_SESSIONS` e de `MAX_TOTAL_BYTES`,
    /// apagando os arquivos das entradas que saíram.
    ///
    /// Sessões ainda abertas nunca são cortadas: o arquivo delas está com um
    /// `TranscriptWriter` na mão, e apagá-lo por baixo faria a gravação
    /// continuar escrevendo num arquivo que não existe mais.
    fn prune(&self) {
        let (snapshot, descartadas) = {
            let mut idx = self.index.lock();
            idx.sort_by(|a, b| b.started_at.cmp(&a.started_at));

            let mut mantidas = Vec::with_capacity(idx.len().min(MAX_SESSIONS));
            let mut fora = Vec::new();
            let mut acumulado: u64 = 0;

            for m in idx.drain(..) {
                let tamanho = fs::metadata(self.dir.join(format!("{}.log", m.id)))
                    .map(|f| f.len())
                    .unwrap_or(0);
                let cabe = mantidas.len() < MAX_SESSIONS && acumulado + tamanho <= MAX_TOTAL_BYTES;
                if cabe || m.ended_at.is_none() {
                    acumulado += tamanho;
                    mantidas.push(m);
                } else {
                    fora.push(m.id);
                }
            }

            if fora.is_empty() {
                *idx = mantidas;
                return;
            }
            *idx = mantidas.clone();
            (mantidas, fora)
        };
        self.save_index(&snapshot);
        for id in descartadas {
            let _ = fs::remove_file(self.log_path(&id));
        }
    }
}

/* -------------------------------- a caneta ------------------------------ */

/// Ponta de escrita de uma sessão. Vive na thread de leitura do PTY e é a
/// única dona do arquivo enquanto a sessão existe.
pub struct TranscriptWriter {
    id: String,
    path: PathBuf,
    store: Arc<TranscriptStore>,
    /// `None` depois de um erro de E/S: a gravação desiste em silêncio em vez
    /// de repetir a falha a cada chunk do PTY.
    file: Option<std::io::BufWriter<File>>,
    escritos: u64,
    ultimo_flush: Instant,
}

impl TranscriptWriter {
    pub fn write(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        let Some(f) = self.file.as_mut() else {
            return;
        };
        if let Err(e) = f.write_all(chunk) {
            eprintln!("[jarvis] gravação do histórico interrompida: {e}");
            self.file = None;
            return;
        }
        self.escritos += chunk.len() as u64;

        if self.escritos > MAX_FILE_BYTES {
            self.compact();
        } else if self.ultimo_flush.elapsed() >= FLUSH_INTERVAL {
            self.flush();
        }
    }

    pub fn flush(&mut self) {
        if let Some(f) = self.file.as_mut() {
            let _ = f.flush();
        }
        self.ultimo_flush = Instant::now();
    }

    /// Reescreve o arquivo mantendo só a metade final.
    ///
    /// O corte cai no meio de qualquer coisa — um caractere UTF-8, uma
    /// sequência ANSI. É aceitável de propósito: o xterm que reproduz isso
    /// depois descarta a sequência quebrada e se realinha na primeira válida,
    /// enquanto procurar uma fronteira segura exigiria varrer megabytes
    /// dentro da thread que alimenta o terminal.
    fn compact(&mut self) {
        self.flush();
        // Solta o arquivo: no Windows não dá para renomear por cima de um
        // handle aberto.
        self.file = None;

        let resultado = (|| -> std::io::Result<()> {
            let mut origem = File::open(&self.path)?;
            let total = origem.metadata()?.len();
            if total > KEEP_AFTER_COMPACT {
                origem.seek(SeekFrom::Start(total - KEEP_AFTER_COMPACT))?;
            }
            let mut cauda = Vec::with_capacity(KEEP_AFTER_COMPACT as usize);
            origem.read_to_end(&mut cauda)?;
            drop(origem);

            let tmp = self.path.with_extension("log.tmp");
            let mut destino = File::create(&tmp)?;
            destino.write_all(&cauda)?;
            destino.sync_all()?;
            drop(destino);
            fs::rename(&tmp, &self.path)?;
            Ok(())
        })();

        match resultado {
            Ok(()) => {
                self.escritos = KEEP_AFTER_COMPACT;
                self.store.mark_truncated(&self.id);
            }
            Err(e) => {
                eprintln!("[jarvis] falha ao compactar o histórico da sessão: {e}");
                // Sem compactar, continuar escrevendo faria o arquivo crescer
                // sem teto nenhum — melhor parar de gravar esta sessão.
                return;
            }
        }

        match OpenOptions::new().append(true).open(&self.path) {
            Ok(f) => self.file = Some(std::io::BufWriter::with_capacity(64 * 1024, f)),
            Err(e) => eprintln!("[jarvis] histórico desta sessão encerrado após compactar: {e}"),
        }
    }
}

impl Drop for TranscriptWriter {
    fn drop(&mut self) {
        self.flush();
    }
}

/* --------------------------------- testes ------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(nome: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jarvis-transcript-{nome}-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn meta(id: &str) -> TranscriptMeta {
        TranscriptMeta {
            id: id.to_string(),
            title: "teste".into(),
            program: "pwsh".into(),
            cwd: "C:/".into(),
            started_at: now_ms(),
            ..Default::default()
        }
    }

    #[test]
    fn grava_e_le_de_volta_os_mesmos_bytes() {
        let store = TranscriptStore::at(temp_dir("ida-e-volta"));
        let mut w = store.begin(meta("s1")).expect("gravação abriu");
        w.write(b"\x1b[32mola\x1b[0m mundo");
        drop(w); // o Drop faz o flush

        let (bytes, total, truncado) = store.read("s1", None).unwrap();
        assert_eq!(bytes, b"\x1b[32mola\x1b[0m mundo");
        assert_eq!(total, bytes.len() as u64);
        assert!(!truncado, "cabia inteiro, nada foi cortado");
    }

    #[test]
    fn leitura_limitada_devolve_a_cauda_e_avisa() {
        let store = TranscriptStore::at(temp_dir("cauda"));
        let mut w = store.begin(meta("s1")).unwrap();
        w.write(&vec![b'a'; 10_000]);
        w.write(b"FIM");
        drop(w);

        let (bytes, total, truncado) = store.read("s1", Some(4096)).unwrap();
        assert_eq!(total, 10_003, "o total é o do arquivo, não o do que veio");
        assert!(truncado);
        assert_eq!(bytes.len(), 4096);
        assert!(bytes.ends_with(b"FIM"), "o fim é o que interessa num terminal");
    }

    #[test]
    fn indice_sobrevive_a_uma_reabertura() {
        let dir = temp_dir("reabre");
        {
            let store = TranscriptStore::at(dir.clone());
            let mut w = store.begin(meta("s1")).unwrap();
            w.write(b"conversa com o agente");
            drop(w);
            store.finish("s1", Some(0));
        }

        let store = TranscriptStore::at(dir);
        let lista = store.list();
        assert_eq!(lista.len(), 1);
        assert_eq!(lista[0].id, "s1");
        assert_eq!(lista[0].exit_code, Some(0));
        assert_eq!(lista[0].bytes, 21);
    }

    #[test]
    fn sessao_pendurada_de_uma_queda_e_fechada_na_abertura_seguinte() {
        let dir = temp_dir("pendurada");
        {
            let store = TranscriptStore::at(dir.clone());
            let mut w = store.begin(meta("s1")).unwrap();
            w.write(b"algo");
            drop(w);
            // Sem `finish`: é exatamente o que acontece num Alt+F4 ou numa
            // queda de energia.
        }

        let store = TranscriptStore::at(dir);
        let lista = store.list();
        assert!(
            lista[0].ended_at.is_some(),
            "a entrada não pode ficar 'aberta' para sempre"
        );
    }

    #[test]
    fn sessao_sem_saida_nenhuma_nao_polui_o_historico() {
        let store = TranscriptStore::at(temp_dir("vazia"));
        let w = store.begin(meta("s1")).unwrap();
        drop(w);
        store.finish("s1", Some(0));
        assert!(store.list().is_empty(), "aba aberta e fechada sem uso não é memória");
    }

    #[test]
    fn apagar_remove_entrada_e_arquivo() {
        let dir = temp_dir("apaga");
        let store = TranscriptStore::at(dir.clone());
        let mut w = store.begin(meta("s1")).unwrap();
        w.write(b"x");
        drop(w);

        store.delete("s1").unwrap();
        assert!(store.list().is_empty());
        assert!(!dir.join("s1.log").exists());
        // Apagar de novo não é erro: o índice e o disco podem divergir.
        assert!(store.delete("s1").is_ok());
    }

    #[test]
    fn o_historico_nao_cresce_sem_limite() {
        let dir = temp_dir("poda");
        let store = TranscriptStore::at(dir.clone());

        for i in 0..MAX_SESSIONS + 5 {
            let mut m = meta(&format!("s{i}"));
            // `started_at` crescente: a poda tem que descartar as MAIS antigas.
            m.started_at = 1_000 + i as u64;
            let mut w = store.begin(m).unwrap();
            w.write(b"x");
            drop(w);
            store.finish(&format!("s{i}"), Some(0));
        }

        let lista = store.list();
        assert_eq!(lista.len(), MAX_SESSIONS);
        assert_eq!(lista[0].id, format!("s{}", MAX_SESSIONS + 4), "a mais nova fica");
        assert!(!dir.join("s0.log").exists(), "o arquivo da mais antiga some junto");
    }

    #[test]
    fn a_sessao_em_andamento_nunca_e_podada() {
        // Apagar o arquivo por baixo de um `TranscriptWriter` vivo faria a
        // gravação seguir escrevendo num arquivo que não existe mais.
        let store = TranscriptStore::at(temp_dir("poda-viva"));
        let mut aberta = store.begin(meta("viva")).unwrap();
        aberta.write(b"em andamento");

        for i in 0..MAX_SESSIONS + 5 {
            let mut m = meta(&format!("s{i}"));
            m.started_at = 1_000_000 + i as u64; // todas mais novas que a viva
            let mut w = store.begin(m).unwrap();
            w.write(b"x");
            drop(w);
            store.finish(&format!("s{i}"), Some(0));
        }

        aberta.write(b" e continua");
        drop(aberta);
        let (bytes, _, _) = store.read("viva", None).expect("a gravação viva sobreviveu");
        assert_eq!(bytes, b"em andamento e continua");
    }

    #[test]
    fn indice_corrompido_nao_derruba_as_entradas_boas() {
        let dir = temp_dir("corrompido");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("index.json"),
            r#"{"entries":[{"id":"bom","startedAt":1},{"naoTemId":true},"lixo"]}"#,
        )
        .unwrap();

        let store = TranscriptStore::at(dir);
        let ids: Vec<String> = store.index.lock().iter().map(|m| m.id.clone()).collect();
        assert_eq!(ids, vec!["bom"]);
    }
}
