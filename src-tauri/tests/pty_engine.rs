//! Testes do motor de PTY sem abrir janela.
//!
//! Regra desta suíte: cada teste tem que falhar se a linha que ele protege for
//! removida. Testes que só leem de volta um campo espelhado pelo próprio código
//! não contam como cobertura.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jarvis_lib::protocol::{ExitEvent, SpawnOptions};
use jarvis_lib::pty::{EventSink, PtyManager};
use parking_lot::Mutex;

/* -------------------------------- apoio -------------------------------- */

#[derive(Debug, Clone, PartialEq)]
enum Ev {
    Data { id: String, bytes: Vec<u8>, seq: u64 },
    Exit { id: String, code: i32 },
}

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<Ev>>,
}

impl Recorder {
    /// Saída de uma sessão específica, para provar que duas sessões
    /// simultâneas não misturam bytes.
    fn text_of(&self, id: &str) -> String {
        let mut out = Vec::new();
        for e in self.events.lock().iter() {
            if let Ev::Data { id: i, bytes, .. } = e {
                if i == id {
                    out.extend_from_slice(bytes);
                }
            }
        }
        String::from_utf8_lossy(&out).to_string()
    }

    fn exits(&self) -> Vec<(String, i32)> {
        self.events
            .lock()
            .iter()
            .filter_map(|e| match e {
                Ev::Exit { id, code } => Some((id.clone(), *code)),
                _ => None,
            })
            .collect()
    }

    fn exit_code(&self, id: &str) -> Option<i32> {
        self.exits().into_iter().find(|(i, _)| i == id).map(|(_, c)| c)
    }
}

impl EventSink for Recorder {
    fn data(&self, id: &str, bytes: &[u8], seq: u64) {
        self.events.lock().push(Ev::Data {
            id: id.to_string(),
            bytes: bytes.to_vec(),
            seq,
        });
    }
    fn exit(&self, event: ExitEvent) {
        self.events.lock().push(Ev::Exit {
            id: event.id,
            code: event.exit_code,
        });
    }
}

fn manager() -> (PtyManager, Arc<Recorder>) {
    let rec = Arc::new(Recorder::default());
    let m = PtyManager::new(Arc::clone(&rec) as Arc<dyn EventSink>);
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
        workspace_id: None,
        workspace_name: None,
    }
}

/// Pergunta ao Windows se o processo ainda existe. Formato CSV com o campo
/// de PID comparado por igualdade — não por substring da linha inteira, que
/// poderia colidir com o valor de outra coluna (ex.: uso de memória).
fn pid_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist.exe")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .expect("tasklist");
    let texto = String::from_utf8_lossy(&out.stdout);
    texto.lines().any(|linha| {
        linha
            .split(',')
            .nth(1)
            .map(|campo| campo.trim_matches('"') == pid.to_string())
            .unwrap_or(false)
    })
}

/* ------------------------------ ciclo de vida --------------------------- */

#[test]
fn processo_curto_emite_saida_e_codigo_de_saida() {
    let (m, rec) = manager();
    let info = m
        .spawn(opts("cmd.exe", &["/c", "echo", "jarvis-ok"]))
        .expect("spawn deveria funcionar");

    assert!(info.alive);
    assert!(wait_until(Duration::from_secs(10), || rec
        .text_of(&info.id)
        .contains("jarvis-ok")));
    assert!(wait_until(Duration::from_secs(10), || rec
        .exit_code(&info.id)
        .is_some()));
    assert_eq!(rec.exit_code(&info.id), Some(0));
}

#[test]
fn codigo_de_saida_diferente_de_zero_chega_intacto() {
    let (m, rec) = manager();
    let info = m.spawn(opts("cmd.exe", &["/c", "exit", "7"])).expect("spawn");
    assert!(wait_until(Duration::from_secs(10), || rec
        .exit_code(&info.id)
        .is_some()));
    assert_eq!(rec.exit_code(&info.id), Some(7));
}

#[test]
fn a_saida_final_chega_antes_do_aviso_de_saida() {
    // Se o evento de exit passasse na frente, a UI marcaria a aba como morta
    // e o usuário perderia as últimas linhas — justamente as que dizem por quê.
    let (m, rec) = manager();
    let info = m
        .spawn(opts("cmd.exe", &["/c", "echo", "ultima-linha"]))
        .expect("spawn");

    assert!(wait_until(Duration::from_secs(10), || rec
        .exit_code(&info.id)
        .is_some()));

    let eventos = rec.events.lock();
    let pos_exit = eventos
        .iter()
        .position(|e| matches!(e, Ev::Exit { id, .. } if *id == info.id))
        .expect("houve exit");
    let ultimo_data = eventos
        .iter()
        .enumerate()
        .filter(|(_, e)| matches!(e, Ev::Data { id, .. } if *id == info.id))
        .map(|(i, _)| i)
        .next_back()
        .expect("houve saída");

    assert!(
        ultimo_data < pos_exit,
        "o último bloco de saída veio depois do evento de saída"
    );
    let texto: String = eventos
        .iter()
        .filter_map(|e| match e {
            Ev::Data { bytes, .. } => Some(String::from_utf8_lossy(bytes).to_string()),
            _ => None,
        })
        .collect();
    assert!(texto.contains("ultima-linha"));
}

#[test]
fn escrita_no_stdin_do_shell_interativo_e_ecoada() {
    let (m, rec) = manager();
    let info = m.spawn(opts("cmd.exe", &[])).expect("spawn");

    assert!(wait_until(Duration::from_secs(10), || !rec
        .text_of(&info.id)
        .is_empty()));

    m.write(&info.id, b"echo tunel-vivo\r\n").expect("write");
    assert!(
        wait_until(Duration::from_secs(10), || rec
            .text_of(&info.id)
            .contains("tunel-vivo")),
        "saída capturada: {}",
        rec.text_of(&info.id)
    );

    m.close(&info.id).expect("close");
}

#[test]
fn escrita_em_sessao_morta_e_recusada() {
    let (m, rec) = manager();
    let info = m.spawn(opts("cmd.exe", &["/c", "exit", "0"])).expect("spawn");
    assert!(wait_until(Duration::from_secs(10), || rec
        .exit_code(&info.id)
        .is_some()));
    assert!(m.write(&info.id, b"tarde demais\r\n").is_err());
}

#[test]
fn operacoes_em_sessao_inexistente_falham_sem_derrubar_o_processo() {
    let (m, _rec) = manager();
    assert!(m.write("nao-existe", b"x").is_err());
    assert!(m.resize("nao-existe", "v1", 10, 10).is_err());
    assert!(m.snapshot("nao-existe").is_err());
    assert!(m.kill("nao-existe").is_err());
}

#[test]
fn programa_inexistente_retorna_erro_em_vez_de_panicar() {
    let (m, _rec) = manager();
    assert!(m
        .spawn(opts("programa-que-nao-existe-jarvis.exe", &[]))
        .is_err());
}

#[test]
fn cwd_inexistente_e_recusado_no_spawn() {
    let (m, _rec) = manager();
    let mut o = opts("cmd.exe", &[]);
    o.cwd = Some(r"C:\pasta-que-nao-existe-jarvis-xyz".into());
    assert!(
        m.spawn(o).is_err(),
        "lançar na HOME uma sessão que pediu outra pasta é perigoso demais \
         para falhar em silêncio"
    );
}

/* --------------------------- morte de verdade --------------------------- */

#[test]
fn close_mata_o_processo_de_fato() {
    let (m, _rec) = manager();
    // 60s de vida: se o close não matar, o teste vê o processo vivo.
    let info = m
        .spawn(opts("cmd.exe", &["/c", "ping", "-n", "60", "127.0.0.1"]))
        .expect("spawn");
    let pid = info.pid.expect("pid conhecido");
    assert!(pid_alive(pid), "o processo deveria estar vivo");

    m.close(&info.id).expect("close");

    assert!(
        wait_until(Duration::from_secs(10), || !pid_alive(pid)),
        "o processo {pid} sobreviveu ao close()"
    );
    assert_eq!(m.list().len(), 0);
}

#[test]
fn close_leva_junto_os_processos_netos() {
    // O caso real: `npm run dev` numa aba. Fechar a aba precisa matar o node,
    // senão ele fica segurando porta e pasta, invisível para o usuário.
    let (m, rec) = manager();
    let info = m
        .spawn(opts("powershell.exe", &["-NoLogo", "-NoProfile"]))
        .expect("spawn");

    assert!(wait_until(Duration::from_secs(20), || !rec
        .text_of(&info.id)
        .is_empty()));

    m.write(
        &info.id,
        b"$p = Start-Process -PassThru -NoNewWindow ping -ArgumentList '-n','60','127.0.0.1'; \
          Write-Host \"NETO=$($p.Id)=FIM\"\r\n",
    )
    .expect("write");

    let mut neto: Option<u32> = None;
    assert!(
        wait_until(Duration::from_secs(30), || {
            // A primeira ocorrência é o eco do comando digitado, recheado de
            // códigos de cor do PSReadLine. Vale a última que for um número.
            let t = rec.text_of(&info.id).replace(['\r', '\n'], "");
            for (start, _) in t.match_indices("NETO=") {
                let resto = &t[start + 5..];
                let Some(end) = resto.find("=FIM") else { continue };
                if let Ok(pid) = resto[..end].trim().parse::<u32>() {
                    neto = Some(pid);
                }
            }
            neto.is_some()
        }),
        "não consegui descobrir o PID do neto. saída: {}",
        rec.text_of(&info.id)
    );

    let neto = neto.expect("pid do neto");
    assert!(pid_alive(neto), "o neto deveria estar vivo");

    m.close(&info.id).expect("close");

    assert!(
        wait_until(Duration::from_secs(15), || !pid_alive(neto)),
        "o processo neto {neto} sobreviveu ao fechamento da aba"
    );
}

#[test]
fn shutdown_mata_todas_as_arvores() {
    let (m, _rec) = manager();
    let mut pids = Vec::new();
    for _ in 0..3 {
        let info = m
            .spawn(opts("cmd.exe", &["/c", "ping", "-n", "60", "127.0.0.1"]))
            .expect("spawn");
        pids.push(info.pid.expect("pid"));
    }
    assert_eq!(m.list().len(), 3);
    assert!(pids.iter().all(|p| pid_alive(*p)));

    m.shutdown();

    assert!(
        wait_until(Duration::from_secs(10), || pids
            .iter()
            .all(|p| !pid_alive(*p))),
        "sobrou processo vivo depois do shutdown"
    );
    assert_eq!(m.list().len(), 0);
}

#[test]
fn kill_encerra_o_processo_mas_preserva_a_sessao_para_leitura() {
    let (m, rec) = manager();
    let info = m
        .spawn(opts("cmd.exe", &["/c", "ping", "-n", "60", "127.0.0.1"]))
        .expect("spawn");
    let pid = info.pid.expect("pid");

    m.kill(&info.id).expect("kill");

    assert!(wait_until(Duration::from_secs(10), || !pid_alive(pid)));
    assert!(wait_until(Duration::from_secs(10), || rec
        .exit_code(&info.id)
        .is_some()));
    // Continua listada: o usuário ainda quer ler o que aconteceu antes de morrer.
    assert_eq!(m.list().len(), 1);
    assert!(!m.list()[0].alive);
    assert!(m.snapshot(&info.id).is_ok());
}

#[test]
fn resize_em_sessao_morta_e_recusado() {
    // O master sobrevive ao kill de propósito (leitura pós-morte), mas
    // redimensioná-lo faria SessionInfo contar uma história que não
    // aconteceu: nenhum processo do outro lado ocupa esse espaço.
    let (m, rec) = manager();
    let info = m.spawn(opts("cmd.exe", &["/c", "exit", "0"])).expect("spawn");
    assert!(wait_until(Duration::from_secs(10), || rec
        .exit_code(&info.id)
        .is_some()));

    assert!(m.resize(&info.id, "painel-1", 100, 40).is_err());
}

/* ------------------------------ tamanho real ---------------------------- */

#[test]
fn resize_chega_no_pty_de_verdade() {
    let (m, _rec) = manager();
    let info = m.spawn(opts("cmd.exe", &[])).expect("spawn");

    let aplicado = m.resize(&info.id, "painel-1", 132, 45).expect("resize");
    assert_eq!(aplicado, (132, 45), "o tamanho devolvido bate com o pedido");

    // Lê do master, não do espelho em SessionInfo: comentar a chamada de
    // resize no motor tem que quebrar este teste.
    assert_eq!(m.actual_size(&info.id).expect("size"), (132, 45));
    m.close(&info.id).expect("close");
}

#[test]
fn com_dois_paineis_vence_o_menor_tamanho() {
    // Sem isso, dois splits exibindo a mesma sessão brigariam pelo resize e o
    // conteúdo ficaria cortado no painel menor.
    let (m, _rec) = manager();
    let info = m.spawn(opts("cmd.exe", &[])).expect("spawn");

    m.resize(&info.id, "painel-1", 200, 60).expect("resize 1");
    let aplicado = m.resize(&info.id, "painel-2", 80, 24).expect("resize 2");
    assert_eq!(
        aplicado,
        (80, 24),
        "o retorno tem que refletir o consenso, não o pedido deste painel"
    );
    assert_eq!(m.actual_size(&info.id).expect("size"), (80, 24));

    // Fechado o painel apertado, a sessão volta a ocupar o espaço do maior.
    m.detach_view(&info.id, "painel-2").expect("detach");
    assert_eq!(m.actual_size(&info.id).expect("size"), (200, 60));

    m.close(&info.id).expect("close");
}

#[test]
fn painel_fantasma_de_antes_de_uma_recarga_nao_prende_o_tamanho_para_sempre() {
    // O cenário do bloqueador N1: a janela estava em 80x24, o Vite recarrega
    // (o cleanup do React do painel antigo nunca roda), e um painel novo,
    // maior, se registra. Sem `reset_views`, o `min()` entre o painel morto
    // e o painel novo prende a sessão no tamanho antigo para sempre — e não
    // há como o painel novo se livrar disso, porque ele nem sabe que o
    // painel fantasma existe.
    let (m, _rec) = manager();
    let info = m.spawn(opts("cmd.exe", &[])).expect("spawn");

    m.resize(&info.id, "painel-fantasma", 80, 24).expect("resize fantasma");

    // Simula a reconciliação: o front esqueceu o `viewId` antigo, então o
    // painel fantasma nunca vai chamar `detach_view`. Só o reset resolve.
    m.reset_views(&info.id).expect("reset_views");

    let aplicado = m
        .resize(&info.id, "painel-novo", 220, 60)
        .expect("resize painel novo");
    assert_eq!(
        aplicado,
        (220, 60),
        "sem o reset, o resultado ficaria preso em (80, 24)"
    );
    assert_eq!(m.actual_size(&info.id).expect("size"), (220, 60));

    m.close(&info.id).expect("close");
}

/* ------------------------- histórico e fluxo vivo ----------------------- */

#[test]
fn snapshot_devolve_o_conteudo_e_a_posicao_no_fluxo() {
    let (m, rec) = manager();
    let info = m
        .spawn(opts("cmd.exe", &["/c", "echo", "historico"]))
        .expect("spawn");

    assert!(wait_until(Duration::from_secs(10), || rec
        .text_of(&info.id)
        .contains("historico")));

    let snap = m.snapshot(&info.id).expect("snapshot");
    assert!(String::from_utf8_lossy(&snap.bytes).contains("historico"));

    // O `seq` do instantâneo tem que casar com o último `seq` já emitido —
    // é isso que permite ao front descartar o que chegou em duplicidade.
    let ultimo_seq = rec
        .events
        .lock()
        .iter()
        .filter_map(|e| match e {
            Ev::Data { id, seq, .. } if *id == info.id => Some(*seq),
            _ => None,
        })
        .next_back()
        .expect("houve dados");
    assert_eq!(snap.seq, ultimo_seq);
    assert_eq!(snap.seq as usize, snap.bytes.len());
}

#[test]
fn o_handshake_do_conpty_nao_vaza_para_o_terminal() {
    // O backend responde ao ESC[6n e remove a sequência: se ela chegasse ao
    // front, o xterm responderia de novo e o eco apareceria na tela do usuário.
    let (m, rec) = manager();
    let info = m
        .spawn(opts("cmd.exe", &["/c", "echo", "sem-handshake"]))
        .expect("spawn");

    assert!(wait_until(Duration::from_secs(10), || rec
        .text_of(&info.id)
        .contains("sem-handshake")));

    assert!(
        !rec.text_of(&info.id).contains("\x1b[6n"),
        "o DSR do conhost vazou para o front"
    );
}

#[test]
fn duas_sessoes_simultaneas_nao_misturam_bytes() {
    let (m, rec) = manager();
    let a = m
        .spawn(opts("cmd.exe", &["/c", "for /l %i in (1,1,80) do @echo AAAA"]))
        .expect("spawn a");
    let b = m
        .spawn(opts("cmd.exe", &["/c", "for /l %i in (1,1,80) do @echo BBBB"]))
        .expect("spawn b");

    assert!(wait_until(Duration::from_secs(20), || rec
        .exit_code(&a.id)
        .is_some()
        && rec.exit_code(&b.id).is_some()));

    let ta = rec.text_of(&a.id);
    let tb = rec.text_of(&b.id);
    assert!(ta.contains("AAAA") && !ta.contains("BBBB"), "sessão A contaminada");
    assert!(tb.contains("BBBB") && !tb.contains("AAAA"), "sessão B contaminada");
}

#[test]
fn seq_cresce_monotonicamente_e_bate_com_os_bytes_entregues() {
    let (m, rec) = manager();
    let info = m
        .spawn(opts("cmd.exe", &["/c", "for /l %i in (1,1,200) do @echo linha-%i"]))
        .expect("spawn");

    assert!(wait_until(Duration::from_secs(20), || rec
        .exit_code(&info.id)
        .is_some()));

    let mut acumulado = 0u64;
    let mut anterior = 0u64;
    for e in rec.events.lock().iter() {
        if let Ev::Data { id, bytes, seq } = e {
            if id != &info.id {
                continue;
            }
            acumulado += bytes.len() as u64;
            assert!(*seq >= anterior, "seq andou para trás");
            anterior = *seq;
            assert_eq!(
                *seq, acumulado,
                "o seq tem que refletir exatamente os bytes já entregues"
            );
        }
    }
    assert!(acumulado > 0);
}

#[test]
fn saida_volumosa_chega_inteira() {
    let (m, rec) = manager();
    let info = m
        .spawn(opts(
            "cmd.exe",
            &["/c", "for /l %i in (1,1,2000) do @echo marcador-%i"],
        ))
        .expect("spawn");

    assert!(wait_until(Duration::from_secs(60), || rec
        .exit_code(&info.id)
        .is_some()));

    let t = rec.text_of(&info.id);
    assert!(t.contains("marcador-1\r\n"), "começo perdido");
    assert!(t.contains("marcador-2000"), "fim perdido");
}

#[test]
fn utf8_multibyte_atravessa_intacto() {
    let (m, rec) = manager();
    let info = m.spawn(opts("cmd.exe", &[])).expect("spawn");
    assert!(wait_until(Duration::from_secs(10), || !rec
        .text_of(&info.id)
        .is_empty()));

    m.write(&info.id, "echo ção-日本-🚀\r\n".as_bytes())
        .expect("write");
    assert!(
        wait_until(Duration::from_secs(10), || rec.text_of(&info.id).contains("日本")),
        "saída: {}",
        rec.text_of(&info.id)
    );
    m.close(&info.id).expect("close");
}

/* -------------------------------- listagem ------------------------------ */

#[test]
fn list_reporta_contadores_de_bytes_para_as_estatisticas() {
    let (m, rec) = manager();
    let info = m.spawn(opts("cmd.exe", &[])).expect("spawn");
    assert!(wait_until(Duration::from_secs(10), || !rec
        .text_of(&info.id)
        .is_empty()));

    m.write(&info.id, b"echo contabilidade\r\n").expect("write");
    assert!(wait_until(Duration::from_secs(10), || rec
        .text_of(&info.id)
        .contains("contabilidade")));

    let s = m.list().into_iter().find(|s| s.id == info.id).expect("listada");
    assert_eq!(s.bytes_in, 20, "bytes escritos pelo usuário");
    assert!(s.bytes_out > 0, "bytes produzidos pelo processo");
    m.close(&info.id).expect("close");
}

#[test]
fn list_devolve_as_sessoes_em_ordem_de_criacao() {
    let (m, _rec) = manager();
    let mut ids = Vec::new();
    for _ in 0..3 {
        ids.push(m.spawn(opts("cmd.exe", &[])).expect("spawn").id);
        std::thread::sleep(Duration::from_millis(5));
    }
    let listadas: Vec<String> = m.list().into_iter().map(|s| s.id).collect();
    assert_eq!(listadas, ids);

    let mapa: HashMap<String, ()> = ids.iter().map(|i| (i.clone(), ())).collect();
    assert_eq!(mapa.len(), 3, "ids têm que ser únicos");
    m.shutdown();
}
