use base64::Engine as _;
use tauri::State;

use crate::error::{JarvisError, Result};
use crate::protocol::{ResizeResult, SessionInfo, ShellProfile, SnapshotPayload, SpawnOptions};
use crate::pty::PtyManager;

// Todos os comandos sao `async`. Sem isso o corpo roda inline no handler de
// IPC, ou seja, na thread que bombeia as mensagens da janela: um `pty_write`
// grande num processo que nao le stdin encheria o pipe do ConPTY e congelaria
// a janela inteira ate o filho consumir. Com `async` o Tauri os joga no pool.

#[tauri::command(async)]
pub fn pty_spawn(manager: State<'_, PtyManager>, opts: SpawnOptions) -> Result<SessionInfo> {
    manager.spawn(opts)
}

/// `b64` preserva bytes crus (teclas de controle, colagens com UTF-8
/// multibyte, sequencias ANSI) que uma string JSON corromperia.
#[tauri::command(async)]
pub fn pty_write(manager: State<'_, PtyManager>, id: String, b64: String) -> Result<()> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| JarvisError::BadPayload(e.to_string()))?;
    manager.write(&id, &bytes)
}

/// `view_id` identifica o painel que pede o tamanho. Com splits, dois paineis
/// exibindo a mesma sessao brigariam pelo resize num laco infinito; o motor
/// aplica o menor tamanho pedido e devolve o que realmente aplicou, para o
/// front nao desenhar o xterm maior do que o PTY de fato esta.
#[tauri::command(async)]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    view_id: String,
    cols: u16,
    rows: u16,
) -> Result<ResizeResult> {
    let (cols, rows) = manager.resize(&id, &view_id, cols, rows)?;
    Ok(ResizeResult { cols, rows })
}

#[tauri::command(async)]
pub fn pty_detach_view(manager: State<'_, PtyManager>, id: String, view_id: String) -> Result<()> {
    manager.detach_view(&id, &view_id)
}

/// Esquece todos os paineis registrados para a sessao. Chamado pelo front
/// quando reconcilia apos uma vida nova de pagina (F5, HMR, recuperacao de
/// crash): sem isso, um painel de antes da recarga fica preso em `views`
/// para sempre e a sessao nunca mais cresce alem do menor tamanho que ele
/// pediu.
#[tauri::command(async)]
pub fn pty_reset_views(manager: State<'_, PtyManager>, id: String) -> Result<()> {
    manager.reset_views(&id)
}

#[tauri::command(async)]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<()> {
    manager.kill(&id)
}

#[tauri::command(async)]
pub fn pty_close(manager: State<'_, PtyManager>, id: String) -> Result<()> {
    manager.close(&id)
}

#[tauri::command(async)]
pub fn pty_snapshot(manager: State<'_, PtyManager>, id: String) -> Result<SnapshotPayload> {
    let snap = manager.snapshot(&id)?;
    Ok(SnapshotPayload {
        b64: base64::engine::general_purpose::STANDARD.encode(&snap.bytes),
        seq: snap.seq,
    })
}

#[tauri::command(async)]
pub fn pty_list(manager: State<'_, PtyManager>) -> Vec<SessionInfo> {
    manager.list()
}

#[tauri::command(async)]
pub fn shells_detect() -> Vec<ShellProfile> {
    crate::shells::detect()
}

#[tauri::command(async)]
pub fn app_home_dir() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}
