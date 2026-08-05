pub mod ai;
pub mod claude_usage;
pub mod commands;
pub mod config;
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
    let mut builder = tauri::Builder::default();

    // O `process` existe para o reinício depois de instalar a atualização;
    // sem ele o app fecharia e a pessoa teria que reabrir na mão.
    builder = builder.plugin(tauri_plugin_process::init());
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            let manager = PtyManager::new(Arc::new(TauriSink::new(app.handle().clone())));
            manager.start_dispatcher();
            app.manage(manager);

            let config_mgr = crate::config::ConfigManager::new();
            app.manage(config_mgr);

            let ai_mgr = crate::ai::AiManager::new();
            app.manage(ai_mgr);

            app.manage(crate::commands::CancelMap::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_detach_view,
            commands::pty_reset_views,
            commands::pty_kill,
            commands::pty_close,
            commands::pty_snapshot,
            commands::pty_list,
            commands::shells_detect,
            commands::app_home_dir,
            commands::config_load,
            commands::config_save,
            commands::open_folder_dialog,
            commands::ai_chat,
            commands::ai_cancel,
            commands::ai_models,
            commands::claude_usage_summary,
            commands::claude_settings_get,
            commands::claude_settings_set,
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
