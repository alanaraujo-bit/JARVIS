//! O elo entre a sessão de terminal e a pasta onde o print colado é gravado.
//!
//! Os testes unitários de `clipboard_image` cobrem a codificação do PNG e a
//! escolha da pasta a partir de um `cwd` já resolvido. O que falta provar é
//! justamente o meio do caminho: dado o **id de uma sessão viva**, chegar no
//! diretório de trabalho dela. Se esse elo se perder, a colagem continua
//! "funcionando" — grava o PNG na pasta global — e o agente de IA passa a
//! pedir permissão a cada imagem, que é exatamente o que a funcionalidade
//! existe para evitar.

use std::sync::Arc;
use std::time::Duration;

use jarvis_lib::clipboard_image::pasta_para;
use jarvis_lib::protocol::{ExitEvent, SpawnOptions};
use jarvis_lib::pty::{EventSink, PtyManager};

/// Estes testes olham para o `list()` do gerenciador, não para a saída do
/// shell — o sink existe só porque `PtyManager::new` pede um.
#[derive(Default)]
struct Mudo;

impl EventSink for Mudo {
    fn data(&self, _: &str, _: &[u8], _: u64) {}
    fn exit(&self, _: ExitEvent) {}
}

fn manager() -> PtyManager {
    let m = PtyManager::new(Arc::new(Mudo) as Arc<dyn EventSink>);
    m.start_dispatcher();
    m
}

/// Reproduz o que o comando `clipboard_save_image` faz para achar a pasta.
fn cwd_da_sessao(m: &PtyManager, id: &str) -> Option<String> {
    m.list().into_iter().find(|s| s.id == id).map(|s| s.cwd)
}

#[test]
fn a_pasta_da_colagem_segue_o_diretorio_da_sessao() {
    let pasta = std::env::temp_dir().join(format!("jarvis-sessao-{}", uuid_simples()));
    std::fs::create_dir_all(&pasta).unwrap();

    let m = manager();
    let mut opts = opts_basicas();
    opts.cwd = Some(pasta.to_string_lossy().to_string());
    let sessao = m.spawn(opts).expect("a sessão deveria subir");

    let cwd = cwd_da_sessao(&m, &sessao.id).expect("a sessão viva precisa aparecer em list()");
    let destino = pasta_para(Some(&cwd));

    assert!(
        destino.starts_with(&pasta),
        "o PNG iria para {destino:?}, fora da pasta da sessão {pasta:?} — \
         é aí que o agente de IA passa a pedir permissão"
    );
    assert!(destino.ends_with("clipboard"));
    // O print colado não pode entrar num commit de quem estiver usando o app
    // dentro de um repositório.
    assert_eq!(
        std::fs::read_to_string(pasta.join(".jarvis").join(".gitignore")).unwrap(),
        "*\n"
    );

    let _ = m.close(&sessao.id);
    std::thread::sleep(Duration::from_millis(100));
    let _ = std::fs::remove_dir_all(&pasta);
}

#[test]
fn sessao_desconhecida_nao_inventa_pasta() {
    let m = manager();
    assert!(cwd_da_sessao(&m, "id-que-nunca-existiu").is_none());
    // Sem cwd, a colagem ainda acontece — só que na pasta global do app.
    assert_eq!(pasta_para(None), pasta_para(Some("")));
}

fn opts_basicas() -> SpawnOptions {
    SpawnOptions {
        program: Some("cmd.exe".into()),
        args: vec![],
        cwd: None,
        env: vec![],
        cols: 80,
        rows: 24,
        title: None,
        profile_id: None,
        initial_command: None,
        workspace_id: None,
        workspace_name: None,
    }
}

fn uuid_simples() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|_| "0".into())
}
