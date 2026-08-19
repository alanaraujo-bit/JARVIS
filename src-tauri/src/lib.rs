pub mod agents;
pub mod ai;
pub mod claude_accounts;
pub mod claude_usage;
pub mod claude_usage_live;
pub mod clipboard_image;
pub mod collab;
pub mod commands;
pub mod config;
pub mod error;
pub mod job;
pub mod protocol;
pub mod pty;
pub mod shells;
pub mod sink;
pub mod transcript;

use std::sync::Arc;

use tauri::{Manager, RunEvent, WindowEvent};

use crate::collab::CollabHub;
use crate::pty::PtyManager;
use crate::sink::{FanSink, TauriSink};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // O `process` existe para o reinício depois de instalar a atualização;
    // sem ele o app fecharia e a pessoa teria que reabrir na mão.
    builder = builder.plugin(tauri_plugin_process::init());
    // O `clipboard-manager` existe para o copiar/colar do terminal: o
    // `navigator.clipboard` do WebView2 falha silenciosamente (a leitura
    // exige permissão que o Tauri não concede por padrão), e sem um jeito
    // confiável de ler o clipboard não há colar para as ferramentas de
    // ditado que simulam Ctrl+V.
    builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            // O hub nasce antes do motor de PTY porque a saída dos terminais
            // passa a ser entregue aos dois — janela local e sala — pelo
            // mesmo `EventSink`. Com a sala fechada (o estado normal), o
            // desvio para ela custa uma leitura atômica.
            let hub = Arc::new(CollabHub::new());
            hub.attach(app.handle().clone());

            let sink = FanSink::new(TauriSink::new(app.handle().clone()), Arc::clone(&hub));
            let manager = PtyManager::new(Arc::new(sink))
                .with_transcript(crate::transcript::TranscriptStore::new());
            manager.start_dispatcher();
            app.manage(manager);
            app.manage(hub);

            let config_mgr = crate::config::ConfigManager::new();
            app.manage(config_mgr);

            let ai_mgr = crate::ai::AiManager::new();
            app.manage(ai_mgr);

            app.manage(crate::commands::CancelMap::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::clipboard_save_image,
            commands::clipboard_read_image,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_detach_view,
            commands::pty_reset_views,
            commands::pty_kill,
            commands::pty_close,
            commands::pty_snapshot,
            commands::pty_list,
            commands::transcript_list,
            commands::transcript_read,
            commands::transcript_delete,
            commands::transcript_clear,
            commands::agent_resume_probe,
            commands::shells_detect,
            commands::app_home_dir,
            commands::config_load,
            commands::config_save,
            commands::open_folder_dialog,
            commands::ai_chat,
            commands::ai_cancel,
            commands::ai_models,
            commands::claude_usage_summary,
            commands::claude_usage_by_account,
            commands::claude_usage_live,
            commands::claude_usage_live_by_account,
            commands::claude_settings_get,
            commands::claude_settings_set,
            commands::claude_account_prepare,
            commands::claude_accounts_status,
            commands::claude_account_import,
            commands::claude_account_credentials,
            commands::claude_account_logout,
            commands::claude_account_forget,
            commands::claude_default_login_exists,
            commands::claude_account_migrate_session,
            commands::collab_start,
            commands::collab_stop,
            commands::collab_state,
            commands::collab_share,
            commands::collab_unshare,
            commands::collab_set_approval,
            commands::collab_decide,
            commands::collab_kick,
            commands::collab_chat,
            commands::collab_ai_ask,
            commands::collab_ai_relay,
            commands::collab_tunnel_available,
            commands::collab_tunnel_download,
            commands::collab_tunnel_start,
            commands::collab_tunnel_stop,
            commands::collab_invite_qr,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                // A sala primeiro: fechar os PTYs antes de avisar os
                // convidados deixaria a tela deles congelada num terminal que
                // já morreu, sem nenhuma explicação.
                if let Some(h) = window.try_state::<Arc<CollabHub>>() {
                    h.close("O anfitrião fechou o JARVIS.");
                }
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
                // Vale também para o túnel: um `cloudflared` sobrevivente
                // manteria um endereço público apontando para uma porta que
                // não existe mais.
                if let Some(h) = app.try_state::<Arc<CollabHub>>() {
                    h.close("O anfitrião fechou o JARVIS.");
                }
                if let Some(m) = app.try_state::<PtyManager>() {
                    m.shutdown();
                }
            }
        });
}
