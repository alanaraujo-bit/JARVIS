use base64::Engine as _;
use tauri::{AppHandle, Emitter};

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
