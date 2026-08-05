//! Tentativas de furar o motor de PTY em condições que a suíte principal
//! (`pty_engine.rs`) não cobre: pipe de entrada cheio, resize absurdo, muitas
//! sessões ao mesmo tempo, fechar sessão durante um jorro de saída.
//!
//! Todo teste aqui tem prazo: se o motor travar, o teste falha por timeout
//! num watchdog explícito em vez de pendurar a suíte para sempre.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use jarvis_lib::protocol::{ExitEvent, SpawnOptions};
use jarvis_lib::pty::{EventSink, PtyManager};
use parking_lot::Mutex;

/* -------------------------------- apoio -------------------------------- */

#[derive(Default)]
struct Contador {
    bytes: Mutex<std::collections::HashMap<String, Vec<u8>>>,
    saidas: Mutex<Vec<String>>,
}

impl Contador {
    fn total(&self, id: &str) -> usize {
        self.bytes.lock().get(id).map(|v| v.len()).unwrap_or(0)
    }
    fn texto(&self, id: &str) -> String {
        self.bytes
            .lock()
            .get(id)
            .map(|v| String::from_utf8_lossy(v).to_string())
            .unwrap_or_default()
    }
    fn saiu(&self, id: &str) -> bool {
        self.saidas.lock().iter().any(|s| s == id)
    }
}

impl EventSink for Contador {
    fn data(&self, id: &str, bytes: &[u8], _seq: u64) {
        self.bytes
            .lock()
            .entry(id.to_string())
            .or_default()
            .extend_from_slice(bytes);
    }
    fn exit(&self, event: ExitEvent) {
        self.saidas.lock().push(event.id);
    }
}

fn manager() -> (Arc<PtyManager>, Arc<Contador>) {
    let rec = Arc::new(Contador::default());
    let m = Arc::new(PtyManager::new(Arc::clone(&rec) as Arc<dyn EventSink>));
    m.start_dispatcher();
    (m, rec)
}

fn wait_until(timeout: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    cond()
}

fn opts(program: &str, args: &[&str]) -> SpawnOptions {
    SpawnOptions {
        program: Some(program.into()),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: None,
        env: vec![],
        cols: 100,
        rows: 30,
        title: None,
        profile_id: None,
        initial_command: None,
    }
}

/// Roda `f` numa thread e falha se ela não terminar no prazo. É assim que um
/// travamento vira falha de teste em vez de suíte pendurada.
fn com_prazo<F>(prazo: Duration, nome: &str, f: F)
where
    F: FnOnce() + Send + 'static,
{
    let pronto = Arc::new(AtomicBool::new(false));
    let p2 = Arc::clone(&pronto);
    let h = std::thread::spawn(move || {
        f();
        p2.store(true, Ordering::SeqCst);
    });
    let ok = wait_until(prazo, || pronto.load(Ordering::SeqCst));
    assert!(ok, "`{nome}` não terminou em {prazo:?} — travou");
    h.join().expect("a thread do teste panicou");
}

/* --------------------------- pipe de entrada --------------------------- */

#[test]
fn escrita_gigante_em_processo_que_nao_le_stdin_nao_trava_o_motor() {
    // O ConPTY tem um buffer de entrada finito. Despejar megabytes num
    // processo que nunca lê stdin (`ping -t` só dorme) é o cenário clássico
    // de deadlock: `write_all` bloqueia segurando o lock do writer.
    let (m, _rec) = manager();
    let info = m
        .spawn(opts("ping.exe", &["-n", "60", "127.0.0.1"]))
        .expect("spawn");
    let id = info.id.clone();
    let m2 = Arc::clone(&m);

    // 4 MiB, bem acima de qualquer buffer de pipe do Windows.
    let bloco = vec![b'a'; 64 * 1024];
    com_prazo(Duration::from_secs(30), "escrita gigante", move || {
        for _ in 0..64 {
            // Um erro é resultado aceitável (pipe cheio/fechado); travar não é.
            let _ = m2.write(&id, &bloco);
        }
    });

    // E o motor continua atendendo outras operações depois disso.
    assert!(m.list().iter().any(|s| s.id == info.id));
    let _ = m.close(&info.id);
}

#[test]
fn outra_sessao_continua_respondendo_enquanto_uma_escrita_gigante_acontece() {
    // O lock do writer é por sessão; provar isso importa porque um lock global
    // faria uma aba entupida congelar o app inteiro.
    let (m, rec) = manager();
    let entupida = m
        .spawn(opts("ping.exe", &["-n", "60", "127.0.0.1"]))
        .expect("spawn");

    let m2 = Arc::clone(&m);
    let id = entupida.id.clone();
    let bloco = vec![b'x'; 64 * 1024];
    let jorro = std::thread::spawn(move || {
        for _ in 0..64 {
            let _ = m2.write(&id, &bloco);
        }
    });

    let livre = m.spawn(opts("cmd.exe", &["/c", "echo", "ainda-vivo"])).expect("spawn");
    assert!(
        wait_until(Duration::from_secs(20), || rec
            .texto(&livre.id)
            .contains("ainda-vivo")),
        "a segunda sessão ficou presa atrás da primeira"
    );

    let _ = m.close(&entupida.id);
    let _ = jorro.join();
    let _ = m.close(&livre.id);
}

/* ------------------------------- resize -------------------------------- */

#[test]
fn resize_para_zero_e_corrigido_para_um_em_vez_de_estourar() {
    let (m, _rec) = manager();
    let info = m.spawn(opts("cmd.exe", &[])).expect("spawn");
    let (c, r) = m.resize(&info.id, "v1", 0, 0).expect("resize 0x0 não pode falhar");
    assert_eq!((c, r), (1, 1), "0 vira 1, não 0 nem panic");
    let real = m.actual_size(&info.id).expect("tamanho real");
    assert_eq!(real, (1, 1), "o PTY de verdade recebeu 1x1");
    let _ = m.close(&info.id);
}

#[test]
fn resize_absurdo_nao_derruba_o_processo() {
    let (m, _rec) = manager();
    let info = m.spawn(opts("cmd.exe", &[])).expect("spawn");
    // u16::MAX colunas: ou o ConPTY aceita, ou recusa com erro tratado.
    let resultado = m.resize(&info.id, "v1", u16::MAX, u16::MAX);
    match resultado {
        Ok((c, r)) => assert!(c > 0 && r > 0, "tamanho aplicado inválido: {c}x{r}"),
        Err(e) => assert!(
            e.to_string().contains("redimensionar"),
            "erro devia ser o de resize: {e}"
        ),
    }
    // O importante: a sessão sobreviveu e ainda aceita um tamanho sensato.
    let (c, r) = m.resize(&info.id, "v1", 80, 24).expect("resize de volta");
    assert_eq!((c, r), (80, 24));
    let _ = m.close(&info.id);
}

#[test]
fn spawn_com_zero_colunas_nao_estoura() {
    let (m, _rec) = manager();
    let mut o = opts("cmd.exe", &[]);
    o.cols = 0;
    o.rows = 0;
    let info = m.spawn(o).expect("spawn 0x0 devia ser corrigido, não recusado");
    assert_eq!(m.actual_size(&info.id).unwrap(), (1, 1));
    let _ = m.close(&info.id);
}

/* --------------------------- muitas sessões ---------------------------- */

#[test]
fn dezesseis_sessoes_simultaneas_nao_misturam_nem_perdem_saida() {
    let (m, rec) = manager();
    let mut ids = Vec::new();
    for i in 0..16 {
        // O sufixo evita que `marca-1` case dentro de `marca-10` e produza um
        // falso positivo de "sessões misturadas".
        let marca = format!("marca-{i}-fim");
        let info = m
            .spawn(opts("cmd.exe", &["/c", "echo", &marca]))
            .unwrap_or_else(|e| panic!("spawn da sessão {i} falhou: {e}"));
        ids.push((info.id, marca));
    }

    for (id, marca) in &ids {
        assert!(
            wait_until(Duration::from_secs(30), || rec.texto(id).contains(marca)),
            "sessão {id} nunca entregou `{marca}`"
        );
    }
    // Cada sessão só vê a própria marca.
    for (id, _) in &ids {
        let t = rec.texto(id);
        let quantas = ids.iter().filter(|(_, ma)| t.contains(ma.as_str())).count();
        assert_eq!(quantas, 1, "sessão {id} viu bytes de outra: {t:?}");
    }
    for (id, _) in &ids {
        let _ = m.close(id);
    }
}

/* ------------------- fechar durante um jorro de saída ------------------ */

#[test]
fn fechar_a_sessao_no_meio_de_um_jorro_de_saida_nao_panica_nem_pendura() {
    // `for /L` sem pausa satura o ConPTY; fechar no meio é o caminho mais
    // provável para um "channel closed"/unwrap numa thread de leitura.
    let (m, rec) = manager();
    let info = m
        .spawn(opts(
            "cmd.exe",
            &["/c", "for /L %i in (1,1,200000) do @echo linha-%i"],
        ))
        .expect("spawn");
    let id = info.id.clone();

    assert!(
        wait_until(Duration::from_secs(20), || rec.total(&id) > 10_000),
        "o jorro nunca começou"
    );

    let m2 = Arc::clone(&m);
    let id2 = id.clone();
    com_prazo(Duration::from_secs(20), "close durante jorro", move || {
        m2.close(&id2).expect("close não pode falhar");
    });

    assert!(m.list().iter().all(|s| s.id != id), "sessão continuou na lista");
    // O motor segue de pé depois disso.
    let novo = m.spawn(opts("cmd.exe", &["/c", "echo", "pos-close"])).expect("spawn");
    assert!(wait_until(Duration::from_secs(20), || rec
        .texto(&novo.id)
        .contains("pos-close")));
    let _ = m.close(&novo.id);
}

#[test]
fn shutdown_durante_jorro_termina_sem_pendurar() {
    let (m, rec) = manager();
    let mut ids = Vec::new();
    for _ in 0..4 {
        let info = m
            .spawn(opts(
                "cmd.exe",
                &["/c", "for /L %i in (1,1,200000) do @echo x-%i"],
            ))
            .expect("spawn");
        ids.push(info.id);
    }
    assert!(
        wait_until(Duration::from_secs(20), || ids
            .iter()
            .all(|i| rec.total(i) > 1_000)),
        "os jorros nunca começaram"
    );

    let m2 = Arc::clone(&m);
    com_prazo(Duration::from_secs(30), "shutdown durante jorro", move || {
        m2.shutdown();
    });
    assert!(m.list().is_empty(), "shutdown deixou sessão para trás");
}

/* --------------------------- UTF-8 partido ----------------------------- */

#[test]
fn utf8_multibyte_partido_entre_leituras_chega_intacto_em_volume() {
    // Não basta um acento numa linha curta: o corte entre duas leituras do
    // ConPTY só acontece com volume. 3000 caracteres de 2-3 bytes cada
    // garantem que a fronteira caia no meio de um caractere alguma hora.
    let (m, rec) = manager();
    let unidade = "áçãõ日本";
    let script = format!(
        "$s = '{}' * 500; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Host $s",
        unidade
    );
    let info = m
        .spawn(opts(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", &script],
        ))
        .expect("spawn");

    assert!(
        wait_until(Duration::from_secs(40), || rec.saiu(&info.id)),
        "o processo nunca terminou"
    );
    let texto = rec.texto(&info.id);
    let ocorrencias = texto.matches(unidade).count();
    assert!(
        ocorrencias >= 495,
        "esperava ~500 repetições intactas, vi {ocorrencias} — houve corte de UTF-8. \
         Amostra: {:?}",
        texto.chars().take(200).collect::<String>()
    );
    assert!(
        !texto.contains('\u{FFFD}'),
        "apareceu caractere de substituição (UTF-8 partido entre leituras)"
    );
    let _ = m.close(&info.id);
}

/* ------------------------- robustez de operações ----------------------- */

#[test]
fn operacoes_repetidas_de_close_e_kill_sao_idempotentes() {
    let (m, _rec) = manager();
    let info = m.spawn(opts("cmd.exe", &[])).expect("spawn");
    m.kill(&info.id).expect("primeiro kill");
    // O segundo kill pode falhar, mas não pode panicar nem travar.
    let _ = m.kill(&info.id);
    m.close(&info.id).expect("close");
    // Fechar de novo é no-op silencioso, não erro nem panic.
    m.close(&info.id).expect("close repetido devia ser no-op");
}

#[test]
fn escrita_de_zero_bytes_e_aceita_sem_efeito() {
    let (m, _rec) = manager();
    let info = m.spawn(opts("cmd.exe", &[])).expect("spawn");
    m.write(&info.id, b"").expect("escrita vazia não pode falhar");
    let antes = m.list().iter().find(|s| s.id == info.id).map(|s| s.bytes_in);
    assert_eq!(antes, Some(0));
    let _ = m.close(&info.id);
}

#[test]
fn muitas_views_registradas_convergem_para_o_menor_tamanho() {
    let (m, _rec) = manager();
    let info = m.spawn(opts("cmd.exe", &[])).expect("spawn");
    for i in 0..200 {
        let cols = 200 - i as u16;
        m.resize(&info.id, &format!("v{i}"), cols, 50).expect("resize");
    }
    let (c, _r) = m.resize(&info.id, "v0", 200, 50).expect("resize final");
    assert_eq!(c, 1, "o menor painel (1 coluna) manda no consenso");
    m.reset_views(&info.id).expect("reset");
    let (c, r) = m.resize(&info.id, "novo", 120, 40).expect("resize pos-reset");
    assert_eq!((c, r), (120, 40), "reset_views soltou o tamanho preso");
    let _ = m.close(&info.id);
}
