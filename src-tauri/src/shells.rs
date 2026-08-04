use crate::protocol::ShellProfile;

/// Descobre os shells realmente instalados na máquina. Nada de lista fixa:
/// oferecer um perfil que não existe só produz uma aba que morre na hora.
pub fn detect() -> Vec<ShellProfile> {
    let mut out: Vec<ShellProfile> = Vec::new();

    if let Some(p) = find("pwsh.exe") {
        out.push(ShellProfile {
            id: "pwsh".into(),
            name: "PowerShell 7".into(),
            program: p,
            args: vec!["-NoLogo".into()],
            icon: "pwsh".into(),
            recommended: true,
        });
    }

    if let Some(p) = find("powershell.exe") {
        out.push(ShellProfile {
            id: "windows-powershell".into(),
            name: "Windows PowerShell".into(),
            program: p,
            args: vec!["-NoLogo".into()],
            icon: "pwsh".into(),
            // Só vira padrão se o PowerShell 7 não estiver instalado.
            recommended: out.is_empty(),
        });
    }

    if let Some(p) = find("cmd.exe") {
        out.push(ShellProfile {
            id: "cmd".into(),
            name: "Prompt de Comando".into(),
            program: p,
            args: vec![],
            icon: "cmd".into(),
            recommended: out.is_empty(),
        });
    }

    if let Some(p) = find_git_bash() {
        out.push(ShellProfile {
            id: "git-bash".into(),
            name: "Git Bash".into(),
            program: p,
            args: vec!["-i".into(), "-l".into()],
            icon: "bash".into(),
            recommended: false,
        });
    }

    out.extend(wsl_profiles());

    if out.is_empty() {
        out.push(ShellProfile {
            id: "fallback".into(),
            name: "Shell do sistema".into(),
            program: default_program(),
            args: vec![],
            icon: "cmd".into(),
            recommended: true,
        });
    }

    out
}

/// Programa usado quando o chamador não especifica nada.
pub fn default_program() -> String {
    find("pwsh.exe")
        .or_else(|| find("powershell.exe"))
        .or_else(|| find("cmd.exe"))
        .or_else(|| std::env::var("COMSPEC").ok())
        .unwrap_or_else(|| "cmd.exe".to_string())
}

/// O Git para Windows instala em Program Files, mas também por usuário
/// (`%LOCALAPPDATA%\Programs\Git`) e via scoop/winget, que só aparecem no PATH.
fn find_git_bash() -> Option<String> {
    let mut candidatos: Vec<std::path::PathBuf> = vec![
        r"C:\Program Files\Git\bin\bash.exe".into(),
        r"C:\Program Files (x86)\Git\bin\bash.exe".into(),
    ];
    if let Some(local) = dirs::data_local_dir() {
        candidatos.push(local.join(r"Programs\Git\bin\bash.exe"));
    }
    if let Some(home) = dirs::home_dir() {
        candidatos.push(home.join(r"scoop\apps\git\current\bin\bash.exe"));
    }

    for c in candidatos {
        if c.is_file() {
            return Some(c.to_string_lossy().to_string());
        }
    }

    // Último recurso: o bash do PATH — mas não o atalho do WSL, que mora no
    // System32 e abriria uma sessão Linux com cara de Git Bash.
    let achado = find("bash.exe")?;
    if achado.to_lowercase().contains(r"\system32\") {
        None
    } else {
        Some(achado)
    }
}

/// Uma entrada por distro instalada. Um perfil "WSL genérico" mandaria o
/// usuário com três distros adivinhar em qual delas a aba vai cair.
fn wsl_profiles() -> Vec<ShellProfile> {
    let Some(wsl) = find("wsl.exe") else {
        return vec![];
    };

    let mut perfis: Vec<ShellProfile> = Vec::new();
    if let Ok(out) = std::process::Command::new(&wsl)
        .args(["--list", "--quiet"])
        .output()
    {
        // `wsl --list` responde em UTF-16LE.
        let bytes = out.stdout;
        let texto: String = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect::<Vec<u16>>()
            .iter()
            .filter_map(|&c| char::from_u32(c as u32))
            .collect();

        for linha in texto.lines() {
            let distro = linha.trim().trim_end_matches('\0');
            if distro.is_empty() {
                continue;
            }
            perfis.push(ShellProfile {
                id: format!("wsl:{distro}"),
                name: format!("WSL · {distro}"),
                program: wsl.clone(),
                args: vec!["-d".into(), distro.to_string()],
                icon: "linux".into(),
                recommended: false,
            });
        }
    }

    if perfis.is_empty() {
        perfis.push(ShellProfile {
            id: "wsl".into(),
            name: "WSL (padrão)".into(),
            program: wsl,
            args: vec![],
            icon: "linux".into(),
            recommended: false,
        });
    }

    perfis
}

fn find(exe: &str) -> Option<String> {
    which::which(exe)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detecta_pelo_menos_um_shell_utilizavel() {
        let perfis = detect();
        assert!(!perfis.is_empty());
        // Sem um padrão, a UI não sabe o que abrir no atalho de "novo terminal".
        assert_eq!(
            perfis.iter().filter(|p| p.recommended).count(),
            1,
            "tem que haver exatamente um perfil recomendado"
        );
    }

    #[test]
    fn todo_perfil_aponta_para_um_executavel_que_existe() {
        for p in detect() {
            assert!(
                std::path::Path::new(&p.program).is_file(),
                "perfil {} aponta para {} que não existe",
                p.id,
                p.program
            );
        }
    }

    #[test]
    fn ids_de_perfil_sao_unicos() {
        let perfis = detect();
        let mut ids: Vec<&str> = perfis.iter().map(|p| p.id.as_str()).collect();
        ids.sort_unstable();
        let total = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), total, "ids duplicados quebram a chave da lista");
    }

    #[test]
    fn o_programa_padrao_existe() {
        assert!(std::path::Path::new(&default_program()).is_file());
    }
}
