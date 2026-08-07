//! Contas do Claude Code, isoladas por diretório de configuração.
//!
//! A CLI `claude` guarda tudo — credenciais, settings, histórico de projetos —
//! dentro de um único diretório, `~/.claude` por padrão, e obedece a variável
//! `CLAUDE_CONFIG_DIR` quando ela existe. É esse o gancho que permite ter
//! várias contas ao mesmo tempo: cada conta ganha um diretório próprio, e o
//! terminal que a usa nasce com `CLAUDE_CONFIG_DIR` apontando para lá.
//!
//! Consequência que vale ter em mente: duas contas não compartilham nada.
//! Nem login (que é o ponto), nem `settings.json`, nem `CLAUDE.md`, nem
//! histórico de sessões. Por isso `prepare` sabe semear uma conta nova com o
//! que faz sentido copiar da configuração principal — sem isso, cada conta
//! nova começaria sem as instruções e preferências que o usuário já tinha.
//!
//! Este módulo nunca devolve token nenhum para o front. O que ele lê do
//! `.credentials.json` são os campos de *estado* (tipo de assinatura, quando
//! expira); os campos de credencial ficam onde estão.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{JarvisError, Result};

/// Estado de uma conta, do ponto de vista da interface.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub id: String,
    /// Caminho absoluto do `CLAUDE_CONFIG_DIR` desta conta.
    pub config_dir: String,
    /// A pasta existe no disco.
    pub prepared: bool,
    /// Há credenciais gravadas — ou seja, alguém já fez `/login` aqui.
    pub logged_in: bool,
    /// `"pro"`, `"max"`, … como a própria CLI grava. `None` quando não logada.
    pub subscription_type: Option<String>,
    /// Epoch em milissegundos do fim da validade do token de acesso.
    pub expires_at: Option<u64>,
    pub rate_limit_tier: Option<String>,
}

/// Só o que interessa do `.credentials.json`. Os campos de token existem no
/// arquivo e são deliberadamente **não** declarados aqui: o que não é lido
/// não pode vazar para o front por descuido num `Serialize` futuro.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OauthEstado {
    #[serde(default)]
    expires_at: Option<u64>,
    #[serde(default)]
    subscription_type: Option<String>,
    #[serde(default)]
    rate_limit_tier: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredenciaisArquivo {
    #[serde(default)]
    claude_ai_oauth: Option<OauthEstado>,
}

/// Raiz das contas, ao lado do `config.json` do próprio JARVIS.
///
/// Fica no diretório de configuração do app, e não em `~/.claude-<algo>`,
/// para que desinstalar/limpar o JARVIS não deixe pastas órfãs espalhadas na
/// home do usuário.
pub fn accounts_root() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("JARVIS");
    path.push("claude-accounts");
    path
}

/// O diretório padrão da CLI — a conta que já existia antes do JARVIS.
pub fn default_claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}

/// Recusa qualquer id que não seja um identificador simples.
///
/// O id vem do front e vira **componente de caminho**: sem esta checagem, um
/// id como `../../..` apontaria o `CLAUDE_CONFIG_DIR` — e o `forget`, que
/// apaga recursivamente — para fora da raiz de contas. O front gera ids
/// seguros, mas o backend não pode depender disso.
fn valida_id(id: &str) -> Result<&str> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id)
    } else {
        Err(JarvisError::BadPayload(format!(
            "id de conta inválido: {id:?}"
        )))
    }
}

pub fn account_dir(id: &str) -> Result<PathBuf> {
    Ok(accounts_root().join(valida_id(id)?))
}

/// Arquivos copiados da configuração principal para uma conta nova.
///
/// Deliberadamente curto: são as coisas que o usuário escreveu e espera ter
/// em toda conta. `projects/` (o histórico de conversas) fica de fora de
/// propósito — é o que alimenta o painel de uso, e copiá-lo faria uma conta
/// recém-criada nascer parecendo já ter gastado tokens. `.credentials.json`
/// também fica fora daqui: copiar login é um pedido explícito
/// (`import_credentials`), não um efeito colateral de criar a conta.
const SEMENTES: &[&str] = &["settings.json", "CLAUDE.md"];

/// Cria a pasta da conta, opcionalmente semeando-a com as preferências da
/// configuração principal. Devolve o caminho para o front guardar.
///
/// Idempotente: chamar de novo numa conta que já existe não sobrescreve nada
/// — quem já editou o `settings.json` de uma conta não pode vê-lo voltar ao
/// original só porque o app reabriu.
pub fn prepare(id: &str, semear: bool) -> Result<String> {
    let dir = account_dir(id)?;
    fs::create_dir_all(&dir).map_err(|e| JarvisError::ConfigIo(e.to_string()))?;

    if semear {
        if let Some(origem) = default_claude_dir() {
            for nome in SEMENTES {
                let de = origem.join(nome);
                let para = dir.join(nome);
                if de.is_file() && !para.exists() {
                    let _ = fs::copy(&de, &para);
                }
            }
        }
    }

    Ok(dir.to_string_lossy().to_string())
}

/// Copia o login da configuração principal para a conta.
///
/// Serve ao caso de estreia: a conta que a pessoa já usava no terminal vira
/// uma conta do JARVIS sem precisar de um `/login` novo. É cópia e não
/// movimento — o `~/.claude` original continua funcionando fora do app.
pub fn import_credentials(id: &str) -> Result<()> {
    let dir = account_dir(id)?;
    fs::create_dir_all(&dir).map_err(|e| JarvisError::ConfigIo(e.to_string()))?;

    let origem = default_claude_dir()
        .map(|d| d.join(".credentials.json"))
        .filter(|p| p.is_file())
        .ok_or_else(|| {
            JarvisError::ConfigIo("não há login salvo em ~/.claude para importar".into())
        })?;

    fs::copy(&origem, dir.join(".credentials.json"))
        .map_err(|e| JarvisError::ConfigIo(e.to_string()))?;
    Ok(())
}

/// Apaga só as credenciais: a conta continua existindo, com suas preferências
/// e seu histórico, mas deslogada. É o "sair" — diferente de `forget`.
pub fn logout(id: &str) -> Result<()> {
    let cred = account_dir(id)?.join(".credentials.json");
    match fs::remove_file(&cred) {
        Ok(()) => Ok(()),
        // Já estava deslogada: o resultado desejado já vale.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(JarvisError::ConfigIo(e.to_string())),
    }
}

/// Apaga a pasta inteira da conta — login, preferências e histórico de uso.
pub fn forget(id: &str) -> Result<()> {
    let dir = account_dir(id)?;
    if !dir.exists() {
        return Ok(());
    }
    // Cinto e suspensório sobre o `valida_id`: mesmo que a validação um dia
    // afrouxe, um caminho que não esteja sob a raiz das contas não é apagado.
    if !dir.starts_with(accounts_root()) {
        return Err(JarvisError::BadPayload(
            "recusando apagar um diretório fora da raiz de contas".into(),
        ));
    }
    fs::remove_dir_all(&dir).map_err(|e| JarvisError::ConfigIo(e.to_string()))?;
    Ok(())
}

/// Recusa qualquer id de sessão que não seja um nome de arquivo simples —
/// mesma cautela do `valida_id`, porque isto também vira componente de
/// caminho (`<sessão>.jsonl`).
fn valida_session_id(id: &str) -> Result<&str> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id)
    } else {
        Err(JarvisError::BadPayload(format!(
            "id de sessão inválido: {id:?}"
        )))
    }
}

/// Copia a conversa de uma conta para outra — só o `.jsonl` daquela sessão,
/// não a pasta do projeto inteira, para não arrastar junto conversas de
/// outros dias que por acaso vivem na mesma pasta.
///
/// É o que permite trocar a conta de um painel já aberto sem perder a
/// conversa: o terminal velho morre (a variável de ambiente da conta só é
/// lida no nascimento do processo, não há como mudá-la nele em voo), mas o
/// `claude --resume` do terminal novo encontra a conversa esperando na conta
/// de destino.
///
/// Copia, não move: a conta de origem continua podendo retomar a mesma
/// conversa depois. `from_config_dir: None` é a instalação padrão da CLI
/// (`~/.claude`), do mesmo jeito que em todo o resto deste módulo.
///
/// Silenciosamente não faz nada quando a conversa não existe na origem — uma
/// sessão sem uma pergunta sequer pode nunca ter sido gravada em disco; nesse
/// caso o `--resume` do lado de lá vai falhar sozinho, e a pessoa vê o motivo
/// na tela do terminal, o que é melhor que um erro genérico aqui.
pub fn migrate_session(
    from_config_dir: Option<&str>,
    to_config_dir: &str,
    cwd: &str,
    session_id: &str,
) -> Result<()> {
    let session_id = valida_session_id(session_id)?;
    let from_root = match from_config_dir {
        Some(d) => PathBuf::from(d),
        None => default_claude_dir().ok_or_else(|| {
            JarvisError::ConfigIo("conta padrão do Claude Code não encontrada".into())
        })?,
    };

    let slug = crate::agents::slug_claude(cwd);
    let origem = from_root
        .join("projects")
        .join(&slug)
        .join(format!("{session_id}.jsonl"));
    if !origem.is_file() {
        return Ok(());
    }

    let pasta_destino = PathBuf::from(to_config_dir).join("projects").join(&slug);
    fs::create_dir_all(&pasta_destino).map_err(|e| JarvisError::ConfigIo(e.to_string()))?;
    let destino = pasta_destino.join(format!("{session_id}.jsonl"));
    if origem == destino {
        return Ok(());
    }
    fs::copy(&origem, &destino).map_err(|e| JarvisError::ConfigIo(e.to_string()))?;
    Ok(())
}

/// Lê o estado de uma conta sem tocar em nada.
pub fn status(id: &str) -> Result<AccountStatus> {
    let dir = account_dir(id)?;
    Ok(status_do_dir(id, &dir))
}

fn status_do_dir(id: &str, dir: &Path) -> AccountStatus {
    let mut st = AccountStatus {
        id: id.to_string(),
        config_dir: dir.to_string_lossy().to_string(),
        prepared: dir.is_dir(),
        ..Default::default()
    };

    let Ok(conteudo) = fs::read_to_string(dir.join(".credentials.json")) else {
        return st;
    };
    // Arquivo ilegível ou de um formato futuro: a conta conta como não
    // logada, e o pior que acontece é a interface oferecer um login a mais.
    let Ok(cred) = serde_json::from_str::<CredenciaisArquivo>(&conteudo) else {
        return st;
    };
    let Some(oauth) = cred.claude_ai_oauth else {
        return st;
    };

    st.logged_in = true;
    st.subscription_type = oauth.subscription_type;
    st.expires_at = oauth.expires_at;
    st.rate_limit_tier = oauth.rate_limit_tier;
    st
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_com_travessia_de_caminho_sao_recusados() {
        assert!(valida_id("..").is_err());
        assert!(valida_id("../outra").is_err());
        assert!(valida_id("a/b").is_err());
        assert!(valida_id("c:\\windows").is_err());
        assert!(valida_id("").is_err());
        assert!(valida_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn ids_gerados_pelo_front_passam() {
        assert!(valida_id("acc-1a2b3c").is_ok());
        assert!(valida_id("pessoal_2").is_ok());
    }

    #[test]
    fn ids_de_sessao_com_travessia_de_caminho_sao_recusados() {
        assert!(valida_session_id("../outra").is_err());
        assert!(valida_session_id("a/b").is_err());
        assert!(valida_session_id("").is_err());
        assert!(valida_session_id("uuid-abc-123").is_ok());
    }

    #[test]
    fn migra_a_conversa_para_a_pasta_da_conta_nova() {
        let base = std::env::temp_dir().join(format!("jarvis-migra-teste-{}", std::process::id()));
        let de = base.join("de");
        let para = base.join("para");
        let cwd = r"C:\Projetos\teste-migracao";
        let slug = crate::agents::slug_claude(cwd);

        let pasta_projeto = de.join("projects").join(&slug);
        fs::create_dir_all(&pasta_projeto).unwrap();
        fs::write(pasta_projeto.join("sessao-1.jsonl"), "{}\n").unwrap();

        migrate_session(Some(&de.to_string_lossy()), &para.to_string_lossy(), cwd, "sessao-1")
            .unwrap();

        let copiado = para.join("projects").join(&slug).join("sessao-1.jsonl");
        assert!(copiado.is_file(), "a conversa devia ter sido copiada para a conta nova");
        // A origem continua existindo: é cópia, não movimento.
        assert!(pasta_projeto.join("sessao-1.jsonl").is_file());

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn migrar_sessao_sem_conversa_gravada_nao_e_erro() {
        let base = std::env::temp_dir().join(format!("jarvis-migra-vazia-{}", std::process::id()));
        let de = base.join("de");
        let para = base.join("para");
        fs::create_dir_all(&de).unwrap();

        let r = migrate_session(
            Some(&de.to_string_lossy()),
            &para.to_string_lossy(),
            r"C:\Projetos\nada",
            "nunca-existiu",
        );
        assert!(r.is_ok());

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn conta_inexistente_vira_status_vazio_em_vez_de_erro() {
        let st = status_do_dir("fantasma", Path::new("Z:/nao/existe/mesmo"));
        assert!(!st.prepared);
        assert!(!st.logged_in);
        assert!(st.subscription_type.is_none());
    }

    #[test]
    fn status_le_o_estado_sem_expor_token() {
        let dir = std::env::temp_dir().join(format!("jarvis-acct-teste-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"segredo","refreshToken":"segredo",
                "expiresAt":1785995435540,"subscriptionType":"pro",
                "rateLimitTier":"default_claude_ai"}}"#,
        )
        .unwrap();

        let st = status_do_dir("teste", &dir);
        assert!(st.logged_in);
        assert_eq!(st.subscription_type.as_deref(), Some("pro"));
        assert_eq!(st.expires_at, Some(1785995435540));

        // O serializado que vai para o front não pode conter o token.
        let json = serde_json::to_string(&st).unwrap();
        assert!(!json.contains("segredo"));

        fs::remove_dir_all(&dir).ok();
    }
}
