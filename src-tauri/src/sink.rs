use std::sync::Arc;

use base64::Engine as _;
use tauri::{AppHandle, Emitter};

use crate::collab::CollabHub;
use crate::protocol::{ev_data, DataEvent, ExitEvent, EV_EXIT};
use crate::pty::EventSink;

/// Liga o motor de PTY ao barramento de eventos do Tauri.
pub struct TauriSink {
    app: AppHandle,
}

impl TauriSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriSink {
    fn data(&self, session_id: &str, bytes: &[u8], seq: u64) {
        let payload = DataEvent {
            id: session_id.to_string(),
            b64: base64::engine::general_purpose::STANDARD.encode(bytes),
            seq,
        };
        let _ = self.app.emit(&ev_data(session_id), payload);
    }

    fn exit(&self, event: ExitEvent) {
        let _ = self.app.emit(EV_EXIT, event);
    }
}

/// Entrega a mesma saída à janela local e à sala compartilhada.
///
/// A tela do anfitrião continua sendo servida exatamente como antes — o
/// caminho dela nem sabe que existe colaboração. O desvio para a sala vem
/// **depois**, e a primeira coisa que ele faz é uma leitura atômica: com a
/// sala fechada, que é o estado normal do app, o custo total desta camada é
/// um `load` relaxado e um `return`.
///
/// A ordem também importa. O anfitrião é quem está com as mãos no teclado; a
/// tela dele não deve esperar o empacotamento de um quadro de rede para
/// receber os bytes que ele acabou de provocar.
pub struct FanSink {
    local: TauriSink,
    hub: Arc<CollabHub>,
}

impl FanSink {
    pub fn new(local: TauriSink, hub: Arc<CollabHub>) -> Self {
        Self { local, hub }
    }
}

impl EventSink for FanSink {
    fn data(&self, session_id: &str, bytes: &[u8], seq: u64) {
        self.local.data(session_id, bytes, seq);
        self.hub.on_pty_data(session_id, bytes, seq);
    }

    fn exit(&self, event: ExitEvent) {
        self.hub.on_pty_exit(&event.id, event.exit_code);
        self.local.exit(event);
    }
}
