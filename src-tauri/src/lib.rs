pub mod commands;
pub mod error;
pub mod job;
pub mod protocol;
pub mod pty;
pub mod shells;
pub mod sink;

use std::sync::Arc;

use tauri::{Manager, RunEvent, WindowEvent};

use crate::pty::PtyManager;
use crate::sink::TauriSink;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let manager = PtyManager::new(Arc::new(TauriSink::new(app.handle().clone())));
            manager.start_dispatcher();
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_detach_view,
            commands::pty_kill,
            commands::pty_close,
            commands::pty_snapshot,
            commands::pty_list,
            commands::shells_detect,
            commands::app_home_dir,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if let Some(m) = window.try_state::<PtyManager>() {
                    m.shutdown();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("erro ao inicializar o JARVIS")
        .run(|app, event| {
            // Rede de segurança: qualquer caminho de saída passa por aqui,
            // então nenhum shell fica órfão segurando arquivos do projeto.
            if let RunEvent::Exit = event {
                if let Some(m) = app.try_state::<PtyManager>() {
                    m.shutdown();
                }
            }
        });
}
