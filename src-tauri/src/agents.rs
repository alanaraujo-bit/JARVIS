//! Retomada de conversas com agentes de IA que rodam no terminal.
//!
//! O histórico gravado (`transcript.rs`) guarda os *bytes* de uma sessão: dá
//! para reler a conversa, mas não para continuá-la — o processo morreu. Só
//! que o agente também guarda a conversa dele, do lado de lá, num formato que
//! ele sabe retomar:
//!
//! | agente     | onde a conversa mora                                  | como retoma                  |
//! |------------|-------------------------------------------------------|------------------------------|
//! | Claude Code| `<CLAUDE_CONFIG_DIR>/projects/<pasta>/<uuid>.jsonl`    | `claude --resume <uuid>`     |
//! | opencode   | banco próprio, consultável por `opencode session list` | `opencode --session <id>`    |
//! | freebuff   | `~/.config/manicode/projects/<projeto>/chats/<id>/`    | `freebuff --continue <id>`   |
//!
//! Este módulo é a ponte entre as duas metades: dada uma gravação do JARVIS,
//! descobre **qual** conversa do agente é aquela e monta o comando que a
//! traz de volta.
//!
//! Duas estratégias, nesta ordem:
//!
//! 1. **Vínculo gravado.** Quando é o JARVIS quem sobe o agente (o
//!    `autoCommand` do workspace), ele injeta `--session-id <uuid>` no
//!    `claude` e guarda esse uuid junto da gravação. Aí não há adivinhação:
//!    aquela aba É aquela conversa, mesmo que existam cinco conversas na
//!    mesma pasta.
//!
//! 2. **Reconhecimento por pasta e horário.** Para tudo que o JARVIS não
//!    iniciou — o usuário digitou `claude` com as próprias mãos, ou a
//!    gravação é anterior a esta versão — sobra procurar no depósito do
//!    agente uma conversa na mesma pasta cuja atividade caia dentro da janela
//!    em que aquele terminal esteve vivo. Não é infalível com duas abas
//!    simultâneas na mesma pasta, e por isso o resultado diz (`exact`) se veio
//!    do vínculo ou do reconhecimento — a interface avisa a diferença.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;

use crate::transcript::TranscriptMeta;

/// Folga antes do início da gravação. O agente pode ter começado a escrever
/// no arquivo dele um pouco antes do relógio do PTY (ou o relógio pode ter
/// sido ajustado); um minuto cobre isso sem alcançar a sessão anterior.
const FOLGA_ANTES_MS: u64 = 60_000;

/// Folga depois do fim. Maior que a de trás porque um agente costuma gravar
/// o último trecho da conversa *depois* que o terminal já morreu (o processo
/// leva alguns segundos para escoar), e o fim de uma gravação órfã é o mtime
/// do arquivo — que fica atrás da verdade.
const FOLGA_DEPOIS_MS: u64 = 5 * 60_000;

/// Teto de espera por uma CLI externa consultada durante o probe (só o
/// `opencode` hoje). Sem isso, um agente travado prenderia o painel de
/// histórico: o usuário clicou numa sessão e a tela ficaria parada.
const LIMITE_CLI: Duration = Duration::from_secs(8);

/* -------------------------------- agentes ------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Opencode,
    Freebuff,
}

impl AgentKind {
    pub const TODOS: [AgentKind; 3] = [AgentKind::Claude, AgentKind::Opencode, AgentKind::Freebuff];

    pub fn as_str(&self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Opencode => "opencode",
            AgentKind::Freebuff => "freebuff",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude Code",
            AgentKind::Opencode => "opencode",
            AgentKind::Freebuff => "Freebuff",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(AgentKind::Claude),
            "opencode" => Some(AgentKind::Opencode),
            "freebuff" => Some(AgentKind::Freebuff),
            _ => None,
        }
    }

    /// Reconhece o agente pelo primeiro token de um comando.
    ///
    /// Olha só o nome do executável, sem caminho nem extensão: no Windows o
    /// mesmo agente aparece como `claude`, `claude.cmd` e
    /// `C:\...\npm\claude.ps1` dependendo de como foi instalado e de quem
    /// escreveu a linha.
    pub fn from_command(cmd: &str) -> Option<Self> {
        let primeiro = tokens(cmd).into_iter().next()?;
        let base = primeiro.replace('\\', "/");
        let base = base.rsplit('/').next().unwrap_or(&base).to_lowercase();
        let base = base
            .strip_suffix(".exe")
            .or_else(|| base.strip_suffix(".cmd"))
            .or_else(|| base.strip_suffix(".bat"))
            .or_else(|| base.strip_suffix(".ps1"))
            .unwrap_or(&base);
        match base {
            "claude" => Some(AgentKind::Claude),
            "opencode" => Some(AgentKind::Opencode),
            // `manicode` é o nome de origem do freebuff — a pasta de config
            // dele ainda se chama assim.
            "freebuff" | "manicode" => Some(AgentKind::Freebuff),
            _ => None,
        }
    }
}

/* ---------------------- o comando que sobe o agente --------------------- */

/// Resultado de `preparar_comando_inicial`.
pub struct Preparado {
    /// O que de fato será digitado no terminal.
    pub command: String,
    pub kind: Option<AgentKind>,
    /// Id da conversa que este comando vai abrir, quando é possível saber de
    /// antemão (injetado por nós, ou explícito no comando do usuário).
    pub session_id: Option<String>,
}

/// Prepara o comando de auto-início de um terminal.
///
/// Para o `claude` sem flags de sessão, acrescenta `--session-id <uuid>`:
/// é isso que dá ao JARVIS o direito de dizer, semanas depois, "esta aba era
/// esta conversa" em vez de "era alguma conversa desta pasta, por volta
/// daquela hora". O uuid é novo a cada terminal, então nunca colide com uma
/// conversa existente.
///
/// Nada é injetado quando o usuário já disse o que quer (`--resume`,
/// `--continue`, `--session-id`): mexer aí mudaria o comando dele.
pub fn preparar_comando_inicial(cmd: &str) -> Preparado {
    let kind = AgentKind::from_command(cmd);
    let toks = tokens(cmd);

    match kind {
        Some(AgentKind::Claude) => {
            if let Some(id) = valor_de(&toks, &["--session-id"]) {
                return Preparado {
                    command: cmd.to_string(),
                    kind,
                    session_id: Some(id),
                };
            }
            if tem_flag(&toks, &["--resume", "-r", "--continue", "-c", "--fork-session"]) {
                // Retomada pedida pelo usuário: o id (se houver) é o da
                // conversa que vai continuar — e continua sendo o dela depois.
                return Preparado {
                    command: cmd.to_string(),
                    kind,
                    session_id: valor_de(&toks, &["--resume", "-r"]),
                };
            }
            // `-p`/`--print` é execução não interativa: o terminal roda e
            // acaba, não há conversa para retomar.
            if tem_flag(&toks, &["-p", "--print"]) {
                return Preparado {
                    command: cmd.to_string(),
                    kind,
                    session_id: None,
                };
            }
            let id = uuid::Uuid::new_v4().to_string();
            Preparado {
                command: format!("{cmd} --session-id {id}"),
                kind,
                session_id: Some(id),
            }
        }
        Some(AgentKind::Opencode) => Preparado {
            command: cmd.to_string(),
            kind,
            // O opencode não deixa escolher o id da sessão na linha de
            // comando; o que sobra é reconhecê-la depois pelo horário.
            session_id: valor_de(&toks, &["--session", "-s"]),
        },
        Some(AgentKind::Freebuff) => Preparado {
            command: cmd.to_string(),
            kind,
            session_id: valor_de(&toks, &["--continue"]),
        },
        None => Preparado {
            command: cmd.to_string(),
            kind: None,
            session_id: None,
        },
    }
}

/// Monta o comando que retoma a conversa, preservando o resto da linha
/// original (um `--dangerously-skip-permissions` que o usuário tinha posto no
/// `autoCommand` continua valendo na retomada).
pub fn comando_de_retomada(
    kind: AgentKind,
    comando_original: Option<&str>,
    session_id: Option<&str>,
) -> String {
    let originais = comando_original.map(tokens).unwrap_or_default();
    let programa = originais
        .first()
        .cloned()
        .unwrap_or_else(|| kind.as_str().to_string());

    // Fora as flags de sessão da linha antiga: elas seriam substituídas pelas
    // novas e, repetidas, mandariam o agente abrir duas conversas. O nome é
    // comparado antes do `=` para `--resume <id>` e `--resume=<id>` caírem
    // no mesmo caso; e o `--fork-session` do Claude também é sessão — forçar
    // uma retomada já traz o id da conversa, pedir um fork por cima seria
    // duas ordens ao mesmo tempo.
    let descartar: &[&str] = match kind {
        AgentKind::Claude => &[
            "--session-id", "--resume", "-r", "--continue", "-c", "--fork-session",
        ],
        AgentKind::Opencode => &["--session", "-s", "--continue", "-c", "--fork"],
        AgentKind::Freebuff => &["--continue"],
    };
    let com_valor: &[&str] = match kind {
        AgentKind::Claude => &["--session-id", "--resume", "-r", "--fork-session"],
        AgentKind::Opencode => &["--session", "-s"],
        AgentKind::Freebuff => &["--continue"],
    };

    let mut resto: Vec<String> = Vec::new();
    let mut i = 1;
    while i < originais.len() {
        let t = originais[i].as_str();
        let (nome, valor_igual) = t
            .split_once('=')
            .map(|(n, v)| (n, Some(v)))
            .unwrap_or((t, None));
        if descartar.contains(&nome) {
            // Pula o valor junto: como token seguinte quando a flag não veio
            // com `=` (`--resume <id>`), ou dentro do próprio token quando
            // veio (`--resume=<id>`) — que já fica de fora do resto.
            if com_valor.contains(&nome)
                && valor_igual.is_none()
                && originais.get(i + 1).is_some_and(|v| !v.starts_with('-'))
            {
                i += 1;
            }
            i += 1;
            continue;
        }
        resto.push(originais[i].clone());
        i += 1;
    }

    let retomada: Vec<String> = match (kind, session_id) {
        (AgentKind::Claude, Some(id)) => vec!["--resume".into(), id.into()],
        (AgentKind::Claude, None) => vec!["--continue".into()],
        (AgentKind::Opencode, Some(id)) => vec!["--session".into(), id.into()],
        (AgentKind::Opencode, None) => vec!["--continue".into()],
        (AgentKind::Freebuff, Some(id)) => vec!["--continue".into(), id.into()],
        (AgentKind::Freebuff, None) => vec!["--continue".into()],
    };

    let mut partes = vec![programa];
    partes.extend(retomada);
    partes.extend(resto);
    partes
        .into_iter()
        .map(|p| aspas_se_precisar(&p))
        .collect::<Vec<_>>()
        .join(" ")
}

/* ------------------------------ a descoberta ---------------------------- */

/// Como retomar a conversa de uma gravação.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResume {
    pub kind: AgentKind,
    /// Nome do agente para a interface mostrar.
    pub label: &'static str,
    pub session_id: Option<String>,
    /// Primeira pergunta da conversa, quando o depósito do agente guarda algo
    /// assim. É o que deixa o usuário reconhecer a conversa sem abri-la.
    pub title: Option<String>,
    /// Última atividade conhecida da conversa.
    pub updated_at: u64,
    /// A linha pronta para o terminal novo.
    pub command: String,
    /// `CLAUDE_CONFIG_DIR` em que a conversa vive, quando não é o padrão.
    /// Retomar com a conta errada abriria uma conversa que não existe lá.
    pub config_dir: Option<String>,
    /// `true` = a conversa foi identificada pelo id; `false` = é a mais
    /// recente da pasta dentro da janela de tempo, um palpite bem fundado.
    pub exact: bool,
}

/// Uma conversa encontrada no depósito de um agente.
#[derive(Debug, Clone)]
struct Conversa {
    id: String,
    title: Option<String>,
    criada_em: u64,
    atualizada_em: u64,
    config_dir: Option<String>,
}

/// Descobre como continuar a conversa de uma gravação. `None` quando não há
/// nada de agente ali (um terminal comum) ou quando o depósito do agente não
/// tem nenhuma conversa que case.
pub fn resolver(meta: &TranscriptMeta) -> Option<AgentResume> {
    resolver_com(meta, &conversas)
}

/// O corpo de `resolver`, com o depósito de conversas injetado.
///
/// Separado só para os testes poderem alimentar conversas em memória, sem
/// tocar no disco real do usuário: a escolha entre o vínculo exato e o
/// reconhecimento por pasta e horário é a parte mais delicada da feature e
/// merece ser exercitada.
fn resolver_com(
    meta: &TranscriptMeta,
    conversas: &dyn Fn(AgentKind, &str) -> Vec<Conversa>,
) -> Option<AgentResume> {
    let inicio = meta.started_at.saturating_sub(FOLGA_ANTES_MS);
    let fim = meta.ended_at.unwrap_or_else(crate::pty::now_ms) + FOLGA_DEPOIS_MS;

    // 1. Vínculo gravado: o JARVIS subiu o agente e sabe o id.
    if let (Some(kind), Some(id)) = (
        meta.agent_kind.as_deref().and_then(AgentKind::from_str),
        meta.agent_session_id.as_deref(),
    ) {
        let achada = conversas(kind, &meta.cwd).into_iter().find(|c| c.id == id);
        // A conversa pode não existir mais (o usuário apagou, ou o agente
        // nunca chegou a gravar nada porque ninguém digitou pergunta
        // nenhuma). Sem lastro no disco, oferecer a retomada daria erro na
        // cara do usuário; melhor cair para o reconhecimento por horário.
        if let Some(c) = achada {
            return Some(monta(kind, meta, c, true));
        }
    }

    // 2. Reconhecimento: a conversa daquela pasta que estava ativa naquela
    // janela. Se a gravação sabe o agente, só ele é consultado; senão, os
    // três, e vence quem tem a atividade mais recente dentro da janela.
    let candidatos: Vec<AgentKind> = meta
        .agent_kind
        .as_deref()
        .and_then(AgentKind::from_str)
        .or_else(|| meta.auto_command.as_deref().and_then(AgentKind::from_command))
        .map(|k| vec![k])
        .unwrap_or_else(|| AgentKind::TODOS.to_vec());

    let mut melhor: Option<(AgentKind, Conversa)> = None;
    for kind in candidatos {
        let dentro = conversas(kind, &meta.cwd)
            .into_iter()
            // A conversa tem que ter *começado* antes de a aba morrer e
            // registrado atividade depois de a aba nascer — é a definição de
            // "aconteceu enquanto aquele terminal estava aberto".
            .filter(|c| c.criada_em <= fim && c.atualizada_em >= inicio)
            .max_by_key(|c| c.atualizada_em);
        if let Some(c) = dentro {
            let troca = melhor
                .as_ref()
                .map_or(true, |(_, atual)| c.atualizada_em > atual.atualizada_em);
            if troca {
                melhor = Some((kind, c));
            }
        }
    }

    let (kind, conversa) = melhor?;
    Some(monta(kind, meta, conversa, false))
}

fn monta(kind: AgentKind, meta: &TranscriptMeta, c: Conversa, exact: bool) -> AgentResume {
    AgentResume {
        kind,
        label: kind.label(),
        command: comando_de_retomada(kind, meta.auto_command.as_deref(), Some(&c.id)),
        session_id: Some(c.id),
        title: c.title,
        updated_at: c.atualizada_em,
        config_dir: c.config_dir,
        exact,
    }
}

/// Conversas de um agente para uma pasta, sem filtro de tempo.
fn conversas(kind: AgentKind, cwd: &str) -> Vec<Conversa> {
    match kind {
        AgentKind::Claude => conversas_claude(cwd),
        AgentKind::Opencode => conversas_opencode(cwd),
        AgentKind::Freebuff => conversas_freebuff(cwd),
    }
}

/* --------------------------------- Claude -------------------------------- */

/// O nome que o Claude Code dá à pasta de um projeto: o caminho inteiro com
/// todo caractere que não é letra ou número virando `-`. `C:\Users\Ana\App`
/// vira `C--Users-Ana-App`.
pub fn slug_claude(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Todo `CLAUDE_CONFIG_DIR` que este JARVIS conhece: a instalação padrão da
/// CLI mais uma pasta por conta cadastrada.
///
/// Varrer todas em vez de perguntar ao front qual era a conta é proposital:
/// o vínculo aba↔conta vive só na memória da execução, então depois de
/// reiniciar o app ninguém mais sabe em qual conta aquela conversa foi
/// gravada — mas o arquivo dela está numa dessas pastas, e achá-lo responde
/// a pergunta.
fn claude_config_dirs() -> Vec<(Option<String>, PathBuf)> {
    let mut out: Vec<(Option<String>, PathBuf)> = Vec::new();
    if let Some(padrao) = crate::claude_accounts::default_claude_dir() {
        out.push((None, padrao));
    }
    if let Ok(entradas) = std::fs::read_dir(crate::claude_accounts::accounts_root()) {
        for e in entradas.flatten() {
            if e.path().is_dir() {
                out.push((Some(e.path().to_string_lossy().to_string()), e.path()));
            }
        }
    }
    out
}

fn conversas_claude(cwd: &str) -> Vec<Conversa> {
    let slug = slug_claude(cwd);
    let mut out = Vec::new();

    for (config_dir, raiz) in claude_config_dirs() {
        let dir = raiz.join("projects").join(&slug);
        let Ok(entradas) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entradas.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Some((criada_em, atualizada_em)) = tempos(&path) else {
                continue;
            };
            out.push(Conversa {
                id: id.to_string(),
                title: primeira_pergunta_claude(&path),
                criada_em,
                atualizada_em,
                config_dir: config_dir.clone(),
            });
        }
    }
    out
}

/// Primeira mensagem do usuário de um `.jsonl` de sessão do Claude Code.
///
/// Lê só o começo do arquivo: uma conversa longa passa de 10 MB e o painel
/// pede isto para várias sessões ao rolar a lista.
fn primeira_pergunta_claude(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader, Read};

    let f = std::fs::File::open(path).ok()?;
    let mut leitor = BufReader::new(f.take(512 * 1024));
    let mut linha = String::new();
    while leitor.read_line(&mut linha).ok()? > 0 {
        let valor: serde_json::Value = match serde_json::from_str(linha.trim()) {
            Ok(v) => v,
            Err(_) => {
                linha.clear();
                continue;
            }
        };
        // Sidechains são conversas de subagentes: o texto delas é instrução
        // interna, não a pergunta que a pessoa lembraria de ter feito.
        let sidechain = valor.get("isSidechain").and_then(|v| v.as_bool()) == Some(true);
        if valor.get("type").and_then(|v| v.as_str()) == Some("user") && !sidechain {
            if let Some(t) = valor.pointer("/message/content").and_then(|c| match c {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Array(itens) => itens
                    .iter()
                    .find_map(|i| i.get("text").and_then(|t| t.as_str()).map(str::to_string)),
                _ => None,
            }) {
                return Some(resume_texto(&t));
            }
        }
        linha.clear();
    }
    None
}

/* -------------------------------- opencode ------------------------------- */

/// O opencode guarda as sessões num banco próprio, mas expõe uma listagem em
/// JSON já filtrada pela pasta — o que evita depender do formato interno do
/// banco, que é dele e pode mudar sem aviso.
fn conversas_opencode(cwd: &str) -> Vec<Conversa> {
    let Ok(exe) = which::which("opencode") else {
        return Vec::new();
    };
    let mut cmd = Command::new(exe);
    cmd.args(["session", "list", "--format", "json", "-n", "50"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Sem isto, cada consulta pisca um console preto na frente do usuário.
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let Some(saida) = roda_com_limite(cmd, LIMITE_CLI) else {
        return Vec::new();
    };
    let Ok(lista) = serde_json::from_str::<Vec<serde_json::Value>>(&saida) else {
        return Vec::new();
    };

    lista
        .into_iter()
        .filter(|s| {
            // A listagem já vem do escopo da pasta, mas o campo `directory`
            // existe e conferir é barato: um dia o escopo pode virar "projeto"
            // e passar a incluir subpastas.
            s.get("directory")
                .and_then(|d| d.as_str())
                .map_or(true, |d| mesmo_caminho(d, cwd))
        })
        .filter_map(|s| {
            let id = s.get("id")?.as_str()?.to_string();
            let criada_em = s.get("created").and_then(|v| v.as_u64()).unwrap_or(0);
            let atualizada_em = s
                .get("updated")
                .and_then(|v| v.as_u64())
                .unwrap_or(criada_em);
            Some(Conversa {
                id,
                title: s
                    .get("title")
                    .and_then(|t| t.as_str())
                    .map(|t| resume_texto(t)),
                criada_em,
                atualizada_em,
                config_dir: None,
            })
        })
        .collect()
}

/* -------------------------------- freebuff ------------------------------- */

/// O freebuff (antigo manicode) grava cada conversa numa pasta cujo **nome é
/// o id** que o `--continue` aceita, dentro de um diretório por projeto.
fn conversas_freebuff(cwd: &str) -> Vec<Conversa> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let projetos = home.join(".config").join("manicode").join("projects");
    let Ok(entradas) = std::fs::read_dir(&projetos) else {
        return Vec::new();
    };

    // O projeto é nomeado pelo último trecho do caminho, então dois projetos
    // homônimos em pastas diferentes caem no mesmo diretório. Por isso a
    // conferência do `projectRoot` logo abaixo: sem ela, "JARVIS" do disco C
    // devolveria as conversas do "JARVIS" do disco D.
    let preferida = Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().to_string());

    let mut out = Vec::new();
    for projeto in entradas.flatten() {
        if let Some(nome) = &preferida {
            let combina = projeto.file_name().to_string_lossy().eq_ignore_ascii_case(nome);
            if !combina {
                continue;
            }
        }
        let Ok(chats) = std::fs::read_dir(projeto.path().join("chats")) else {
            continue;
        };
        for chat in chats.flatten() {
            let dir = chat.path();
            if !dir.is_dir() || !raiz_freebuff_confere(&dir, cwd) {
                continue;
            }
            let Some(id) = dir.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            // O mtime da pasta não acompanha a escrita dos arquivos dentro
            // dela em todo sistema de arquivos; o das mensagens, sim.
            let alvo = if dir.join("chat-messages.json").is_file() {
                dir.join("chat-messages.json")
            } else {
                dir.join("log.jsonl")
            };
            let Some((criada_dir, _)) = tempos(&dir) else {
                continue;
            };
            let atualizada_em = tempos(&alvo).map(|(_, m)| m).unwrap_or(criada_dir);
            out.push(Conversa {
                id: id.to_string(),
                title: primeiro_prompt_freebuff(&dir),
                criada_em: criada_dir,
                atualizada_em,
                config_dir: None,
            });
        }
    }
    out
}

/// `true` quando a conversa é mesmo desta pasta — ou quando não dá para
/// saber (chats antigos não gravam `run-state.json`), caso em que a
/// homonímia do diretório de projeto já é indício suficiente.
fn raiz_freebuff_confere(dir: &Path, cwd: &str) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(dir.join("run-state.json")) else {
        return true;
    };
    // O `projectRoot` está nos primeiros bytes do arquivo, que tem megabytes.
    let mut buf = vec![0u8; 4096];
    let Ok(n) = f.read(&mut buf) else {
        return true;
    };
    let texto = String::from_utf8_lossy(&buf[..n]);
    let Some(inicio) = texto.find("\"projectRoot\":\"") else {
        return true;
    };
    let resto = &texto[inicio + "\"projectRoot\":\"".len()..];
    let Some(fim) = resto.find('"') else {
        return true;
    };
    // O JSON escapa as barras do Windows; desfazer é o bastante para comparar.
    mesmo_caminho(&resto[..fim].replace("\\\\", "\\"), cwd)
}

fn primeiro_prompt_freebuff(dir: &Path) -> Option<String> {
    let texto = std::fs::read_to_string(dir.join("chat-meta.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&texto).ok()?;
    v.get("firstPrompt")
        .and_then(|p| p.as_str())
        .map(resume_texto)
}

/* -------------------------------- utilidades ----------------------------- */

/// Quebra uma linha de comando em tokens respeitando aspas duplas — um
/// caminho com espaço (`"C:\Program Files\..."`) é um token só.
fn tokens(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut atual = String::new();
    let mut aspas = false;
    for c in cmd.chars() {
        match c {
            '"' => aspas = !aspas,
            c if c.is_whitespace() && !aspas => {
                if !atual.is_empty() {
                    out.push(std::mem::take(&mut atual));
                }
            }
            c => atual.push(c),
        }
    }
    if !atual.is_empty() {
        out.push(atual);
    }
    out
}

fn aspas_se_precisar(t: &str) -> String {
    if t.contains(' ') && !t.starts_with('"') {
        format!("\"{t}\"")
    } else {
        t.to_string()
    }
}

fn tem_flag(toks: &[String], flags: &[&str]) -> bool {
    toks.iter().any(|t| flags.contains(&t.as_str()))
}

/// Valor de uma flag (`--resume <id>`), aceitando também `--resume=<id>`.
/// `None` quando a flag não está lá ou veio sem valor — `--resume` sozinho é
/// legítimo no Claude Code (abre o seletor interativo).
fn valor_de(toks: &[String], flags: &[&str]) -> Option<String> {
    for (i, t) in toks.iter().enumerate() {
        if let Some((nome, valor)) = t.split_once('=') {
            if flags.contains(&nome) && !valor.is_empty() {
                return Some(valor.to_string());
            }
        }
        if flags.contains(&t.as_str()) {
            let prox = toks.get(i + 1)?;
            if prox.starts_with('-') {
                return None;
            }
            return Some(prox.clone());
        }
    }
    None
}

/// Compara caminhos do jeito que o Windows os trata: sem diferenciar
/// maiúsculas nem o tipo de barra, e ignorando uma barra final.
fn mesmo_caminho(a: &str, b: &str) -> bool {
    let normaliza = |s: &str| {
        s.replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    normaliza(a) == normaliza(b)
}

/// `(criação, última modificação)` em epoch ms. A criação é o que marca o
/// início de uma conversa; quando o sistema de arquivos não a guarda, o mtime
/// é a única aproximação disponível.
fn tempos(path: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(path).ok()?;
    let ms = |t: std::time::SystemTime| {
        t.duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    };
    let modificado = m.modified().ok().map(ms).unwrap_or(0);
    let criado = m.created().ok().map(ms).unwrap_or(modificado);
    Some((criado.min(modificado), modificado))
}

/// Roda um processo e devolve a saída, desistindo (e matando o filho) depois
/// do limite.
fn roda_com_limite(mut cmd: Command, limite: Duration) -> Option<String> {
    let mut filho = cmd.spawn().ok()?;
    let inicio = std::time::Instant::now();
    loop {
        match filho.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if inicio.elapsed() >= limite {
                    let _ = filho.kill();
                    let _ = filho.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
    let saida = filho.wait_with_output().ok()?;
    Some(String::from_utf8_lossy(&saida.stdout).to_string())
}

/// Uma linha só, curta o bastante para caber num rótulo.
fn resume_texto(t: &str) -> String {
    let limpo: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if limpo.chars().count() <= 80 {
        return limpo;
    }
    let corte: String = limpo.chars().take(80).collect();
    format!("{corte}…")
}

/* --------------------------------- testes -------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconhece_o_agente_pelo_executavel() {
        assert_eq!(AgentKind::from_command("claude"), Some(AgentKind::Claude));
        assert_eq!(
            AgentKind::from_command("claude --resume abc"),
            Some(AgentKind::Claude)
        );
        assert_eq!(
            AgentKind::from_command(r#""C:\Users\Ana\npm\claude.cmd" -c"#),
            Some(AgentKind::Claude)
        );
        assert_eq!(
            AgentKind::from_command("opencode --auto"),
            Some(AgentKind::Opencode)
        );
        assert_eq!(
            AgentKind::from_command("freebuff"),
            Some(AgentKind::Freebuff)
        );
        assert_eq!(AgentKind::from_command("npm run dev"), None);
        assert_eq!(AgentKind::from_command(""), None);
    }

    #[test]
    fn injeta_id_de_sessao_no_claude_para_poder_retomar_depois() {
        let p = preparar_comando_inicial("claude");
        let id = p.session_id.expect("o id tem que existir");
        assert_eq!(p.command, format!("claude --session-id {id}"));
        assert!(uuid::Uuid::parse_str(&id).is_ok(), "tem que ser um uuid válido");
    }

    #[test]
    fn nao_mexe_no_comando_quando_o_usuario_ja_pediu_retomada() {
        let p = preparar_comando_inicial("claude --resume abc123");
        assert_eq!(p.command, "claude --resume abc123");
        assert_eq!(p.session_id.as_deref(), Some("abc123"));

        let p = preparar_comando_inicial("claude --continue");
        assert_eq!(p.command, "claude --continue");
        assert_eq!(p.session_id, None);
    }

    #[test]
    fn nao_injeta_id_em_execucao_nao_interativa() {
        // `-p` roda e sai; não há conversa para reabrir, e o id só sujaria a
        // linha de comando.
        let p = preparar_comando_inicial("claude -p \"quantos testes existem\"");
        assert_eq!(p.command, "claude -p \"quantos testes existem\"");
        assert_eq!(p.session_id, None);
    }

    #[test]
    fn nao_injeta_nada_em_quem_nao_e_agente() {
        let p = preparar_comando_inicial("npm run dev");
        assert_eq!(p.command, "npm run dev");
        assert_eq!(p.kind, None);
    }

    #[test]
    fn monta_a_retomada_preservando_as_outras_flags() {
        let cmd = comando_de_retomada(
            AgentKind::Claude,
            Some("claude --session-id antigo --dangerously-skip-permissions"),
            Some("novo-id"),
        );
        assert_eq!(
            cmd,
            "claude --resume novo-id --dangerously-skip-permissions",
            "a flag de sessão antiga sai, o resto da linha fica"
        );

        assert_eq!(
            comando_de_retomada(AgentKind::Opencode, Some("opencode --auto"), Some("ses_1")),
            "opencode --session ses_1 --auto"
        );
        assert_eq!(
            comando_de_retomada(AgentKind::Freebuff, None, Some("2026-08-05T23-36-48.130Z")),
            "freebuff --continue 2026-08-05T23-36-48.130Z"
        );
    }

    #[test]
    fn sem_id_a_retomada_cai_na_conversa_mais_recente_da_pasta() {
        assert_eq!(comando_de_retomada(AgentKind::Claude, None, None), "claude --continue");
        assert_eq!(
            comando_de_retomada(AgentKind::Opencode, None, None),
            "opencode --continue"
        );
    }

    #[test]
    fn o_slug_do_claude_casa_com_o_que_a_cli_grava() {
        assert_eq!(
            slug_claude(r"C:\Users\Alan Araujo\Projetos\JARVIS"),
            "C--Users-Alan-Araujo-Projetos-JARVIS"
        );
        assert_eq!(
            slug_claude(r"C:\Users\Alan Araujo\Projetos\copy.master"),
            "C--Users-Alan-Araujo-Projetos-copy-master"
        );
    }

    #[test]
    fn le_flag_com_igual_e_sem() {
        let t = tokens("claude --session-id=abc --model opus");
        assert_eq!(valor_de(&t, &["--session-id"]).as_deref(), Some("abc"));
        let t = tokens("claude --session-id abc");
        assert_eq!(valor_de(&t, &["--session-id"]).as_deref(), Some("abc"));
        // Flag sem valor não pode capturar a flag seguinte como se fosse um id.
        let t = tokens("claude --resume --verbose");
        assert_eq!(valor_de(&t, &["--resume"]), None);
    }

    #[test]
    fn tokens_respeitam_aspas() {
        assert_eq!(
            tokens(r#""C:\Program Files\x\claude.cmd" -p "duas palavras""#),
            vec![r"C:\Program Files\x\claude.cmd", "-p", "duas palavras"]
        );
    }

    #[test]
    fn caminhos_do_windows_comparam_sem_ligar_para_barra_ou_caixa() {
        assert!(mesmo_caminho(r"C:\Projetos\JARVIS", "c:/projetos/jarvis/"));
        assert!(!mesmo_caminho(r"C:\Projetos\JARVIS", r"D:\Projetos\JARVIS"));
    }

    #[test]
    fn a_retomada_descarta_flags_de_sessao_na_forma_com_igual_tambem() {
        assert_eq!(
            comando_de_retomada(
                AgentKind::Claude,
                Some("claude --resume=antigo --dangerously-skip-permissions"),
                Some("novo-id"),
            ),
            "claude --resume novo-id --dangerously-skip-permissions"
        );
        // `--fork-session` também é sessão no Claude: a retomada não pode
        // carregar os dois pedidos ao mesmo tempo.
        assert_eq!(
            comando_de_retomada(
                AgentKind::Claude,
                Some("claude --fork-session antiga --dangerously-skip-permissions"),
                Some("novo-id"),
            ),
            "claude --resume novo-id --dangerously-skip-permissions"
        );
    }

    /* ------------------------ a descoberta (resolver) ------------------------ */

    fn meta_de_teste(
        inicio: u64,
        fim: u64,
        agente: Option<&str>,
        sessao: Option<&str>,
    ) -> TranscriptMeta {
        TranscriptMeta {
            id: "sessao-teste".into(),
            title: "teste".into(),
            program: "pwsh".into(),
            args: vec![],
            cwd: r"C:\Projetos\teste".into(),
            profile_id: None,
            workspace_id: None,
            workspace_name: None,
            auto_command: agente.map(str::to_string),
            agent_kind: agente.map(str::to_string),
            agent_session_id: sessao.map(str::to_string),
            started_at: inicio,
            ended_at: Some(fim),
            exit_code: Some(0),
            truncated: false,
            bytes: 0,
        }
    }

    fn conversa(id: &str, criada_em: u64, atualizada_em: u64) -> Conversa {
        Conversa {
            id: id.to_string(),
            title: None,
            criada_em,
            atualizada_em,
            config_dir: None,
        }
    }

    #[test]
    fn o_vinculo_gravado_vence_a_conversa_mais_recente_da_pasta() {
        // Duas conversas na mesma pasta: a do vínculo é a mais antiga. O id
        // gravado tem que ganhar mesmo assim — foi exatamente para isso que
        // o `--session-id` foi injetado na abertura daquela aba.
        let meta = meta_de_teste(1_000_000, 2_000_000, Some("claude"), Some("id-velho"));
        let deposito = |_kind: AgentKind, _cwd: &str| {
            vec![
                conversa("id-velho", 900_000, 1_100_000),
                conversa("id-novo", 1_500_000, 1_900_000),
            ]
        };
        let r = resolver_com(&meta, &deposito).expect("tem que achar a conversa");
        assert!(r.exact, "vínculo por id é exato, sem adivinhação");
        assert_eq!(r.session_id.as_deref(), Some("id-velho"));
    }

    #[test]
    fn vinculo_sem_lastro_no_disco_cai_no_reconhecimento_por_horario() {
        // O id gravado não existe mais no depósito (o usuário apagou a
        // conversa, ou o agente nunca chegou a gravar nada). Oferecer uma
        // retomada por id daria erro na cara do usuário; sobra reconhecer a
        // conversa da pasta ativa na janela da gravação.
        let meta = meta_de_teste(1_000_000, 2_000_000, Some("claude"), Some("id-sumido"));
        let deposito =
            |_kind: AgentKind, _cwd: &str| vec![conversa("outra", 1_200_000, 1_800_000)];
        let r = resolver_com(&meta, &deposito).expect("cai no reconhecimento");
        assert!(!r.exact, "é um palpite fundamentado, não um vínculo");
        assert_eq!(r.session_id.as_deref(), Some("outra"));
    }

    #[test]
    fn conversa_fora_da_janela_da_gravacao_nao_conta() {
        // A conversa terminou antes de a aba nascer: não aconteceu naquela
        // sessão, e oferecê-la como se fosse dela mentiria para o usuário.
        let meta = meta_de_teste(1_000_000, 2_000_000, Some("claude"), Some("id-x"));
        let deposito = |_kind: AgentKind, _cwd: &str| vec![conversa("velha", 100_000, 900_000)];
        assert!(resolver_com(&meta, &deposito).is_none());
    }

    #[test]
    fn sem_vinculo_os_tres_agentes_concorrem_e_vence_o_mais_recente() {
        // Gravação anterior a esta versão: não há agente gravado, e a
        // descoberta pergunta aos três; vence quem teve atividade mais
        // recente dentro da janela.
        let meta = meta_de_teste(1_000_000, 2_000_000, None, None);
        let deposito = |kind: AgentKind, _cwd: &str| match kind {
            AgentKind::Claude => vec![conversa("c1", 1_000_000, 1_050_000)],
            AgentKind::Opencode => vec![conversa("o1", 1_300_000, 1_600_000)],
            AgentKind::Freebuff => vec![conversa("f1", 1_100_000, 1_200_000)],
        };
        let r = resolver_com(&meta, &deposito).expect("tem que achar uma");
        assert_eq!(r.session_id.as_deref(), Some("o1"), "o opencode foi o mais recente");
        assert!(!r.exact);
    }

    #[test]
    fn resumo_de_texto_cabe_num_rotulo() {
        assert_eq!(resume_texto("uma\n  pergunta   curta"), "uma pergunta curta");
        let longo = "a".repeat(200);
        let r = resume_texto(&longo);
        assert_eq!(r.chars().count(), 81, "80 caracteres mais as reticências");
    }
}
