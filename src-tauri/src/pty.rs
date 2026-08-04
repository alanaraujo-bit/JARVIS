use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::{Condvar, Mutex};
use portable_pty::{CommandBuilder, MasterPty, PtySize};

use crate::error::{JarvisError, Result};
use crate::job::Job;
use crate::protocol::{ExitEvent, SessionInfo, Snapshot, SpawnOptions};

/// SaÃ­da do motor de PTY. O `PtyManager` nÃ£o conhece Tauri: quem entrega os
/// eventos Ã© injetado. Isso mantÃ©m o nÃºcleo testÃ¡vel sem abrir uma janela.
pub trait EventSink: Send + Sync + 'static {
    /// `seq` Ã© a contagem acumulada de bytes da sessÃ£o ao fim deste lote.
    /// O front usa isso para casar o instantÃ¢neo com o fluxo ao vivo sem
    /// duplicar nem perder saÃ­da.
    fn data(&self, session_id: &str, bytes: &[u8], seq: u64);
    fn exit(&self, event: ExitEvent);
}

/// Quanto de saÃ­da guardamos por sessÃ£o para restaurar a tela quando a aba
/// volta a ser montada. 512 KiB cobre folgado uma tela cheia + histÃ³rico Ãºtil.
const SCROLLBACK_BYTES: usize = 512 * 1024;

/// Teto GLOBAL do que espera o prÃ³ximo flush. Por sessÃ£o, 20 abas barulhentas
/// multiplicariam o limite por 20; o custo de memÃ³ria tem que ser do app.
const PENDING_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Intervalo de coalescÃªncia. Emitir a cada leitura do PTY afoga a ponte IPC;
/// agrupar em ~8ms alinha com o frame do WebView sem latÃªncia perceptÃ­vel.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// Quanto a thread de espera segura o evento de saÃ­da para as Ãºltimas linhas
/// do processo chegarem antes do aviso de que ele morreu.
const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(400);

/// Device Status Report â€” "informe a posiÃ§Ã£o do cursor".
const DSR_QUERY: &[u8] = b"\x1b[6n";

/// Resposta ao DSR: cursor na origem.
const DSR_REPLY: &[u8] = b"\x1b[1;1R";

/// O ConPTY Ã© criado com `PSUEDOCONSOLE_INHERIT_CURSOR`: o conhost manda um
/// DSR e **segura a execuÃ§Ã£o do processo filho** atÃ© receber a resposta.
/// Deixar isso para o xterm no front custaria centenas de milissegundos de
/// terminal congelado a cada aba aberta â€” e trava de vez se a aba nascer em
/// segundo plano. EntÃ£o respondemos aqui e sÃ³ procuramos o DSR nesta janela
/// inicial, para nÃ£o roubar consultas legÃ­timas de aplicativos.
const HANDSHAKE_SCAN_BYTES: usize = 8 * 1024;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ------------------------------ scrollback ----------------------------- */

/// HistÃ³rico recente + contador acumulado de bytes. Os dois vivem sob o mesmo
/// lock de propÃ³sito: o instantÃ¢neo precisa do conteÃºdo e da posiÃ§Ã£o no fluxo
/// capturados no mesmo instante, senÃ£o o front nÃ£o consegue casar os dois.
#[derive(Default)]
pub struct Scrollback {
    buf: VecDeque<u8>,
    total: u64,
}

impl Scrollback {
    pub fn push(&mut self, chunk: &[u8]) -> u64 {
        self.buf.extend(chunk.iter().copied());
        self.total += chunk.len() as u64;
        let overflow = self.buf.len().saturating_sub(SCROLLBACK_BYTES);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
        self.total
    }

    pub fn capture(&self) -> (Vec<u8>, u64) {
        (self.buf.iter().copied().collect(), self.total)
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

/* ------------------------------- handshake ----------------------------- */

/// Estado do handshake inicial do ConPTY, por sessÃ£o.
#[derive(Default)]
struct Handshake {
    done: bool,
    scanned: usize,
    /// Bytes retidos porque podem ser um `\x1b[6n` partido entre duas leituras.
    carry: Vec<u8>,
}

impl Handshake {
    /// Devolve o que deve seguir para o front. Quando encontra o DSR, chama
    /// `reply` â€” que escreve a resposta â€” e remove a sequÃªncia do fluxo, para
    /// o terminal do front nÃ£o responder uma segunda vez.
    fn filter(&mut self, chunk: &[u8], reply: impl FnOnce()) -> Vec<u8> {
        if self.done {
            return chunk.to_vec();
        }

        let mut scan = std::mem::take(&mut self.carry);
        scan.extend_from_slice(chunk);
        self.scanned += chunk.len();

        if let Some(pos) = find(&scan, DSR_QUERY) {
            // Responder antes de repassar: o processo filho sÃ³ comeÃ§a depois disto.
            reply();
            scan.drain(pos..pos + DSR_QUERY.len());
            self.done = true;
            return scan;
        }

        if self.scanned >= HANDSHAKE_SCAN_BYTES {
            // Este conhost nÃ£o pede DSR; para de vigiar e deixa tudo passar.
            self.done = true;
            return scan;
        }

        // Segura sÃ³ um sufixo que ainda possa virar `\x1b[6n`.
        let keep = partial_suffix(&scan, DSR_QUERY);
        if keep > 0 {
            self.carry = scan.split_off(scan.len() - keep);
        }
        scan
    }

    /// Bytes retidos que precisam sair antes do fim do fluxo, senÃ£o a sequÃªncia
    /// chega truncada ao terminal e vira lixo na tela.
    fn flush(&mut self) -> Vec<u8> {
        self.done = true;
        std::mem::take(&mut self.carry)
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Comprimento do maior sufixo de `data` que Ã© prefixo prÃ³prio de `needle`.
fn partial_suffix(data: &[u8], needle: &[u8]) -> usize {
    let max = needle.len().min(data.len()).saturating_sub(1);
    (1..=max)
        .rev()
        .find(|&k| data[data.len() - k..] == needle[..k])
        .unwrap_or(0)
}

/* -------------------------------- pending ------------------------------ */

struct Slot {
    bytes: Vec<u8>,
    seq_end: u64,
}

#[derive(Default)]
struct Pending {
    queue: HashMap<String, Slot>,
    total: usize,
}

impl Pending {
    fn push(&mut self, id: &str, chunk: &[u8], seq_end: u64) {
        self.total += chunk.len();
        let slot = self.queue.entry(id.to_string()).or_insert_with(|| Slot {
            bytes: Vec::new(),
            seq_end,
        });
        slot.bytes.extend_from_slice(chunk);
        slot.seq_end = seq_end;
        self.trim();
    }

    /// Sob enxurrada (um `cat` de binÃ¡rio), descarta o comeÃ§o do que ainda nÃ£o
    /// foi entregue: a tela sÃ³ mostra o fim mesmo, e o `seq_end` preservado
    /// avisa o front de que houve um salto.
    fn trim(&mut self) {
        while self.total > PENDING_MAX_BYTES {
            let Some(id) = self
                .queue
                .iter()
                .max_by_key(|(_, s)| s.bytes.len())
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            let Some(slot) = self.queue.get_mut(&id) else {
                break;
            };
            let cut = (slot.bytes.len() / 2).max(1).min(slot.bytes.len());
            slot.bytes.drain(..cut);
            self.total -= cut;
            if slot.bytes.is_empty() {
                self.queue.remove(&id);
            }
        }
    }

    fn drain(&mut self) -> Vec<(String, Slot)> {
        self.total = 0;
        self.queue.drain().collect()
    }
}

/* -------------------------------- sessÃ£o ------------------------------- */

struct Session {
    info: Mutex<SessionInfo>,
    /// `None` depois do fechamento: soltar o master fecha o ConPTY, o que dÃ¡
    /// EOF Ã  thread de leitura e a encerra.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    job: Option<Job>,
    scrollback: Mutex<Scrollback>,
    /// Tamanho pedido por cada painel que exibe esta sessÃ£o. Com splits, dois
    /// painÃ©is brigariam pelo resize; vence o menor, que Ã© o Ãºnico tamanho em
    /// que o conteÃºdo cabe nos dois.
    views: Mutex<HashMap<String, (u16, u16)>>,
    bytes_out: AtomicU64,
    bytes_in: AtomicU64,
}

impl Session {
    fn reply_dsr(&self) {
        if let Some(w) = self.writer.lock().as_mut() {
            let _ = w.write_all(DSR_REPLY);
            let _ = w.flush();
        }
    }

    /// Menor tamanho entre os painÃ©is abertos, ou `None` se nenhum se declarou.
    fn agreed_size(&self) -> Option<(u16, u16)> {
        let views = self.views.lock();
        let cols = views.values().map(|(c, _)| *c).min()?;
        let rows = views.values().map(|(_, r)| *r).min()?;
        Some((cols, rows))
    }

    fn apply_size(&self, cols: u16, rows: u16) -> Result<()> {
        let size = PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        if let Some(m) = self.master.lock().as_ref() {
            m.resize(size)
                .map_err(|e| JarvisError::Resize(e.to_string()))?;
        }
        let mut info = self.info.lock();
        info.cols = size.cols;
        info.rows = size.rows;
        Ok(())
    }

    fn snapshot_info(&self) -> SessionInfo {
        let mut info = self.info.lock().clone();
        info.bytes_out = self.bytes_out.load(Ordering::Relaxed);
        info.bytes_in = self.bytes_in.load(Ordering::Relaxed);
        info
    }

    /// Fecha os canais para o ConPTY. Idempotente.
    fn close_channels(&self) {
        let _ = self.writer.lock().take();
        let _ = self.master.lock().take();
    }
}

/* ------------------------------- gerente ------------------------------- */

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    pending: Arc<(Mutex<Pending>, Condvar)>,
    sink: Arc<dyn EventSink>,
    stopping: Arc<AtomicBool>,
}

impl PtyManager {
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            pending: Arc::new((Mutex::new(Pending::default()), Condvar::new())),
            sink,
            stopping: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Sobe a thread que agrupa a saÃ­da dos PTYs e a entrega ao front.
    /// Dorme em `Condvar`: com zero terminais ativos ela nÃ£o acorda, em vez de
    /// bater 125 vezes por segundo e impedir os estados de baixo consumo.
    pub fn start_dispatcher(&self) {
        let pending = Arc::clone(&self.pending);
        let sink = Arc::clone(&self.sink);
        let stopping = Arc::clone(&self.stopping);
        std::thread::Builder::new()
            .name("jarvis-pty-dispatch".into())
            .spawn(move || {
                let (lock, cvar) = &*pending;
                while !stopping.load(Ordering::Relaxed) {
                    let batch = {
                        let mut p = lock.lock();
                        if p.queue.is_empty() {
                            // Timeout curto para ainda notar o `stopping`.
                            cvar.wait_for(&mut p, Duration::from_millis(250));
                        }
                        if p.queue.is_empty() {
                            continue;
                        }
                        // Segura o lote para dar tempo de mais bytes chegarem.
                        drop(p);
                        std::thread::sleep(FLUSH_INTERVAL);
                        lock.lock().drain()
                    };
                    for (id, slot) in batch {
                        sink.data(&id, &slot.bytes, slot.seq_end);
                    }
                }
            })
            .expect("thread do dispatcher de PTY");
    }

    pub fn spawn(&self, opts: SpawnOptions) -> Result<SessionInfo> {
        let program = opts
            .program
            .clone()
            .unwrap_or_else(crate::shells::default_program);
        let cwd = resolve_cwd(opts.cwd.as_deref())?;

        let size = PtySize {
            rows: opts.rows.max(1),
            cols: opts.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = portable_pty::native_pty_system()
            .openpty(size)
            .map_err(|e| JarvisError::PtyOpen(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&program);
        cmd.args(&opts.args);
        cmd.cwd(&cwd);
        // Sinaliza terminal capaz: sem isso muitas CLIs (inclusive agentes de IA)
        // caem no modo "dumb" e desligam cor e renderizaÃ§Ã£o interativa.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| JarvisError::Spawn {
                program: program.clone(),
                reason: e.to_string(),
            })?;
        // O slave precisa ser fechado aqui: enquanto este processo o mantÃ©m
        // aberto, o master nunca vÃª EOF e a sessÃ£o "trava" apÃ³s o exit.
        drop(pair.slave);

        let pid = child.process_id();
        // Prende a Ã¡rvore: fechar a aba tem que levar junto o que o shell abriu.
        let job = Job::create();
        if let (Some(job), Some(pid)) = (job.as_ref(), pid) {
            job.assign(pid);
        }

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| JarvisError::PtyOpen(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| JarvisError::PtyOpen(e.to_string()))?;
        let killer = child.clone_killer();

        let id = uuid::Uuid::new_v4().to_string();
        let info = SessionInfo {
            id: id.clone(),
            title: opts.title.clone().unwrap_or_else(|| friendly_name(&program)),
            program: program.clone(),
            args: opts.args.clone(),
            cwd: cwd.clone(),
            cols: size.cols,
            rows: size.rows,
            profile_id: opts.profile_id.clone(),
            pid,
            started_at: now_ms(),
            alive: true,
            exit_code: None,
            bytes_out: 0,
            bytes_in: 0,
        };

        let session = Arc::new(Session {
            info: Mutex::new(info.clone()),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(killer),
            job,
            scrollback: Mutex::new(Scrollback::default()),
            views: Mutex::new(HashMap::new()),
            bytes_out: AtomicU64::new(0),
            bytes_in: AtomicU64::new(0),
        });

        self.sessions.lock().insert(id.clone(), Arc::clone(&session));

        let (reader_done_tx, reader_done_rx) = mpsc::channel::<()>();
        self.start_reader(id.clone(), Arc::clone(&session), reader, reader_done_tx)?;
        self.start_waiter(id.clone(), session, child, reader_done_rx)?;

        Ok(info)
    }

    fn start_reader(
        &self,
        id: String,
        session: Arc<Session>,
        mut reader: Box<dyn Read + Send>,
        done: mpsc::Sender<()>,
    ) -> Result<()> {
        let pending = Arc::clone(&self.pending);
        std::thread::Builder::new()
            .name(format!("jarvis-pty-read-{}", &id[..8]))
            .spawn(move || {
                let mut buf = vec![0u8; 64 * 1024];
                let mut handshake = Handshake::default();
                let (lock, cvar) = &*pending;

                let publish = |chunk: &[u8]| {
                    if chunk.is_empty() {
                        return;
                    }
                    session.bytes_out.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                    let seq = session.scrollback.lock().push(chunk);
                    lock.lock().push(&id, chunk, seq);
                    cvar.notify_one();
                };

                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let out = handshake.filter(&buf[..n], || session.reply_dsr());
                            publish(&out);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }

                // NÃ£o deixa bytes presos no `carry` do handshake.
                let tail = handshake.flush();
                publish(&tail);
                let _ = done.send(());
            })
            .map_err(JarvisError::Io)?;
        Ok(())
    }

    fn start_waiter(
        &self,
        id: String,
        session: Arc<Session>,
        mut child: Box<dyn portable_pty::Child + Send + Sync>,
        reader_done: mpsc::Receiver<()>,
    ) -> Result<()> {
        let sink = Arc::clone(&self.sink);
        let pending = Arc::clone(&self.pending);
        std::thread::Builder::new()
            .name(format!("jarvis-pty-wait-{}", &id[..8]))
            .spawn(move || {
                let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
                {
                    let mut info = session.info.lock();
                    info.alive = false;
                    info.exit_code = Some(code);
                }

                // O aviso de saÃ­da nÃ£o pode passar na frente das Ãºltimas linhas
                // do processo. Espera a leitura terminar e a fila esvaziar â€”
                // com teto, porque um neto vivo segura o PTY aberto para sempre.
                let deadline = Instant::now() + EXIT_DRAIN_TIMEOUT;
                let _ = reader_done.recv_timeout(EXIT_DRAIN_TIMEOUT);
                while Instant::now() < deadline {
                    if !pending.0.lock().queue.contains_key(&id) {
                        break;
                    }
                    std::thread::sleep(FLUSH_INTERVAL);
                }

                sink.exit(ExitEvent {
                    id,
                    exit_code: code,
                    ended_at: now_ms(),
                });
            })
            .map_err(JarvisError::Io)?;
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| JarvisError::SessionNotFound(id.to_string()))
    }

    pub fn write(&self, id: &str, bytes: &[u8]) -> Result<()> {
        let s = self.get(id)?;
        if !s.info.lock().alive {
            return Err(JarvisError::SessionDead(id.to_string()));
        }
        let mut guard = s.writer.lock();
        let w = guard
            .as_mut()
            .ok_or_else(|| JarvisError::SessionDead(id.to_string()))?;
        w.write_all(bytes)?;
        w.flush()?;
        drop(guard);
        s.bytes_in.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        Ok(())
    }

    /// Registra o tamanho pedido por um painel e aplica o consenso.
    pub fn resize(&self, id: &str, view_id: &str, cols: u16, rows: u16) -> Result<()> {
        let s = self.get(id)?;
        s.views
            .lock()
            .insert(view_id.to_string(), (cols.max(1), rows.max(1)));
        let (c, r) = s.agreed_size().unwrap_or((cols.max(1), rows.max(1)));
        s.apply_size(c, r)
    }

    /// Um painel deixou de exibir a sessÃ£o: para de considerar o tamanho dele.
    pub fn detach_view(&self, id: &str, view_id: &str) -> Result<()> {
        let s = self.get(id)?;
        s.views.lock().remove(view_id);
        if let Some((c, r)) = s.agreed_size() {
            s.apply_size(c, r)?;
        }
        Ok(())
    }

    /// Mata a Ã¡rvore de processos, mas mantÃ©m a sessÃ£o na lista para o usuÃ¡rio
    /// ainda poder ler a saÃ­da do que morreu.
    pub fn kill(&self, id: &str) -> Result<()> {
        let s = self.get(id)?;
        if let Some(job) = s.job.as_ref() {
            job.terminate();
        }
        s.killer.lock().kill()?;
        Ok(())
    }

    /// Remove a sessÃ£o de vez: derruba a Ã¡rvore e fecha o ConPTY para as
    /// threads dela terminarem.
    pub fn close(&self, id: &str) -> Result<()> {
        let s = self.sessions.lock().remove(id);
        if let Some(s) = s {
            if let Some(job) = s.job.as_ref() {
                job.terminate();
            }
            let _ = s.killer.lock().kill();
            s.close_channels();
        }
        let mut p = self.pending.0.lock();
        if let Some(slot) = p.queue.remove(id) {
            p.total = p.total.saturating_sub(slot.bytes.len());
        }
        Ok(())
    }

    pub fn snapshot(&self, id: &str) -> Result<Snapshot> {
        let s = self.get(id)?;
        let (bytes, seq) = s.scrollback.lock().capture();
        Ok(Snapshot { bytes, seq })
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let mut out: Vec<SessionInfo> = self
            .sessions
            .lock()
            .values()
            .map(|s| s.snapshot_info())
            .collect();
        out.sort_by_key(|s| s.started_at);
        out
    }

    /// Tamanho real do PTY, direto do master â€” nÃ£o o espelho em `SessionInfo`.
    pub fn actual_size(&self, id: &str) -> Result<(u16, u16)> {
        let s = self.get(id)?;
        let guard = s.master.lock();
        let m = guard
            .as_ref()
            .ok_or_else(|| JarvisError::SessionDead(id.to_string()))?;
        let size = m
            .get_size()
            .map_err(|e| JarvisError::Resize(e.to_string()))?;
        Ok((size.cols, size.rows))
    }

    /// Encerra tudo â€” chamado no fechamento da janela para nÃ£o deixar
    /// processos Ã³rfÃ£os segurando a pasta de trabalho do usuÃ¡rio.
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::Relaxed);
        self.pending.1.notify_all();
        let sessions: Vec<Arc<Session>> = self.sessions.lock().drain().map(|(_, s)| s).collect();
        for s in sessions {
            if let Some(job) = s.job.as_ref() {
                job.terminate();
            }
            let _ = s.killer.lock().kill();
            s.close_channels();
        }
    }
}

fn resolve_cwd(requested: Option<&str>) -> Result<String> {
    match requested {
        // Silenciosamente cair na HOME quando a pasta pedida nÃ£o existe Ã©
        // perigoso: um agente de IA lanÃ§ado "no projeto" acabaria rodando em
        // C:\Users\<vocÃª>, e um comando destrutivo dele acertaria o lugar errado.
        Some(dir) => {
            if std::path::Path::new(dir).is_dir() {
                Ok(dir.to_string())
            } else {
                Err(JarvisError::BadCwd(dir.to_string()))
            }
        }
        None => Ok(dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string())),
    }
}

fn friendly_name(program: &str) -> String {
    std::path::Path::new(program)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| program.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acha_sequencia_no_meio_do_buffer() {
        assert_eq!(find(b"abc\x1b[6ndef", DSR_QUERY), Some(3));
        assert_eq!(find(b"sem nada", DSR_QUERY), None);
        assert_eq!(find(b"", DSR_QUERY), None);
    }

    #[test]
    fn sufixo_parcial_reconhece_sequencia_partida() {
        assert_eq!(partial_suffix(b"xx\x1b", DSR_QUERY), 1);
        assert_eq!(partial_suffix(b"xx\x1b[", DSR_QUERY), 2);
        assert_eq!(partial_suffix(b"xx\x1b[6", DSR_QUERY), 3);
        assert_eq!(partial_suffix(b"xx\x1b[6n", DSR_QUERY), 0);
        assert_eq!(partial_suffix(b"nada", DSR_QUERY), 0);
    }

    #[test]
    fn handshake_remove_o_dsr_e_responde_uma_vez_so() {
        let mut h = Handshake::default();
        let mut replies = 0;
        let out = h.filter(b"ola\x1b[6nmundo", || replies += 1);
        assert_eq!(out, b"olamundo");
        assert_eq!(replies, 1);

        // Depois do handshake, um DSR legÃ­timo de um aplicativo passa intacto.
        let out2 = h.filter(b"\x1b[6n", || panic!("nÃ£o deveria responder de novo"));
        assert_eq!(out2, b"\x1b[6n");
    }

    #[test]
    fn handshake_remonta_dsr_partido_entre_duas_leituras() {
        let mut h = Handshake::default();
        let mut replies = 0;

        let a = h.filter(b"abc\x1b[", || replies += 1);
        assert_eq!(a, b"abc", "o prefixo do DSR fica retido");
        assert_eq!(replies, 0);

        let b = h.filter(b"6ndef", || replies += 1);
        assert_eq!(b, b"def");
        assert_eq!(replies, 1);
    }

    #[test]
    fn handshake_devolve_bytes_retidos_no_fim_do_fluxo() {
        let mut h = Handshake::default();
        let out = h.filter(b"texto\x1b[", || {});
        assert_eq!(out, b"texto");
        // Sem isso, o `\x1b[` sumiria e o terminal renderizaria lixo.
        assert_eq!(h.flush(), b"\x1b[");
    }

    #[test]
    fn handshake_desiste_depois_da_janela_inicial() {
        let mut h = Handshake::default();
        let ruido = vec![b'x'; HANDSHAKE_SCAN_BYTES + 1];
        let out = h.filter(&ruido, || panic!("nÃ£o hÃ¡ DSR aqui"));
        assert_eq!(out.len(), ruido.len());
        assert!(h.done);
    }

    #[test]
    fn scrollback_corta_o_historico_mas_nao_o_contador() {
        let mut sb = Scrollback::default();
        sb.push(&vec![b'a'; SCROLLBACK_BYTES]);
        let total = sb.push(b"fim");

        assert_eq!(sb.len(), SCROLLBACK_BYTES, "o histÃ³rico respeita o teto");
        assert_eq!(
            total,
            SCROLLBACK_BYTES as u64 + 3,
            "o contador acumulado continua contando o que jÃ¡ saiu"
        );

        let (bytes, seq) = sb.capture();
        assert_eq!(seq, total);
        assert!(bytes.ends_with(b"fim"));
        assert_eq!(bytes.len(), SCROLLBACK_BYTES);
    }

    #[test]
    fn pending_respeita_o_teto_global_entre_sessoes() {
        let mut p = Pending::default();
        let chunk = vec![b'x'; 1024 * 1024];
        for i in 0..12 {
            p.push(&format!("s{i}"), &chunk, (i as u64 + 1) * chunk.len() as u64);
        }
        assert!(
            p.total <= PENDING_MAX_BYTES,
            "12 MiB entraram, o buffer ficou em {}",
            p.total
        );
        // O corte nÃ£o pode apagar a posiÃ§Ã£o no fluxo: Ã© ela que avisa o front
        // de que houve salto.
        assert!(p.queue.values().all(|s| s.seq_end > 0));
    }

    #[test]
    fn pending_agrupa_por_sessao_sem_misturar_bytes() {
        let mut p = Pending::default();
        p.push("a", b"aaa", 3);
        p.push("b", b"bbb", 3);
        p.push("a", b"AAA", 6);

        let drained: HashMap<String, Slot> = p.drain().into_iter().collect();
        assert_eq!(drained["a"].bytes, b"aaaAAA");
        assert_eq!(drained["a"].seq_end, 6);
        assert_eq!(drained["b"].bytes, b"bbb");
        assert_eq!(p.total, 0);
    }

    #[test]
    fn cwd_inexistente_e_erro_em_vez_de_cair_na_home() {
        let err = resolve_cwd(Some(r"C:\pasta-que-nao-existe-jarvis-xyz"));
        assert!(matches!(err, Err(JarvisError::BadCwd(_))));
        // Sem pedido explÃ­cito, a HOME Ã© o padrÃ£o legÃ­timo.
        assert!(resolve_cwd(None).is_ok());
    }
}
