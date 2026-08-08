/**
 * Ponto de entrada do guardião.
 *
 * Liga as peças: config (env), store (contas criptografadas + inscrições de
 * push), agendador (o cérebro), notificador (Web Push para o celular) e o
 * servidor HTTP (API + PWA). Cada evento do agendador vira um aviso no
 * celular — com cooldown por (conta, tipo) para não encher a tela de ruído.
 */

import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Scheduler, type GuardianEvent } from "./scheduler.js";
import { ApiServer } from "./server.js";
import { Notifier } from "./notifier.js";

function descreve(e: GuardianEvent): string {
  switch (e.t) {
    case "ping_ok": return `ping ok na conta ${e.accountId}`;
    case "ping_fail": return `ping falhou na conta ${e.accountId}: ${e.reason}`;
    case "blocked_weekly": return `conta ${e.accountId} travada no limite semanal${e.resetsAtMs ? ` (libera em ${new Date(e.resetsAtMs).toISOString()})` : ""}`;
    case "weekly_freed": return `conta ${e.accountId} liberou o limite semanal`;
    case "blocked_monthly": return `conta ${e.accountId} no limite mensal de gasto`;
    case "auth_error": return `conta ${e.accountId} com sessão inválida — pede /login`;
    case "window_freed": return `janela de 5h da conta ${e.accountId} liberou`;
  }
}

const cfg = loadConfig();

if (!cfg.authToken || cfg.authToken.length < 16) {
  console.error("[guardian] JARVIS_GUARDIAN_TOKEN ausente ou curto demais. Configure antes de subir.");
  process.exit(1);
}
if (!cfg.secret || cfg.secret.length < 16) {
  console.error("[guardian] JARVIS_GUARDIAN_SECRET ausente ou curto demais. Configure antes de subir.");
  process.exit(1);
}

const store = new Store(cfg.dataDir, cfg.secret);

const notifier = new Notifier(store, {
  publicKey: cfg.vapidPublicKey,
  privateKey: cfg.vapidPrivateKey,
  subject: cfg.vapidSubject,
});

/** Cooldown por (conta, tipo) — não repetir aviso igual em cima de outro. */
const ultimoAviso = new Map<string, number>();
function avisa(chave: string, cooldownMs: number, titulo: string, corpo: string): void {
  const agora = Date.now();
  const ultimo = ultimoAviso.get(chave) ?? 0;
  if (agora - ultimo < cooldownMs) return;
  ultimoAviso.set(chave, agora);
  void notifier.notify(titulo, corpo);
}

const nome = (id: string): string => store.get(id)?.name ?? id;

const scheduler = new Scheduler(store, cfg, (e) => {
  console.log(`[guardian] ${descreve(e)}`);
  switch (e.t) {
    case "ping_ok":
      break; // acontece a cada janela — seria ruído notificar
    case "ping_fail":
      avisa(`falha:${e.accountId}`, 30 * 60_000, "JARVIS: ping falhou", `Conta "${nome(e.accountId)}": ${e.reason}`);
      break;
    case "blocked_weekly": {
      // Fuso explícito: o servidor roda em US East; o usuário está em São Paulo.
      const data = e.resetsAtMs
        ? new Date(e.resetsAtMs).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
        : "em breve";
      avisa(`semanal:${e.accountId}`, 6 * 60 * 60_000, "JARVIS: conta travada", `Conta "${nome(e.accountId)}" travada no limite semanal — libera ${data}.`);
      break;
    }
    case "weekly_freed":
      avisa(`liberou:${e.accountId}`, 6 * 60 * 60_000, "JARVIS: conta liberada! 🎉", `Conta "${nome(e.accountId)}" liberou o limite semanal.`);
      break;
    case "blocked_monthly":
      avisa(`mensal:${e.accountId}`, 12 * 60 * 60_000, "JARVIS: limite mensal", `Conta "${nome(e.accountId)}" atingiu o limite mensal de gasto.`);
      break;
    case "auth_error":
      avisa(`auth:${e.accountId}`, 2 * 60 * 60_000, "JARVIS: sessão inválida", `Conta "${nome(e.accountId)}" precisa de /login no Claude Code.`);
      break;
    case "window_freed":
      avisa(`janela:${e.accountId}`, 30 * 60_000, "JARVIS: janela liberada ✓", `Janela de 5h da conta "${nome(e.accountId)}" liberou.`);
      break;
  }
});

const api = new ApiServer(cfg, store, scheduler);
const server = api.start();
scheduler.start();

for (const sinal of ["SIGTERM", "SIGINT"] as const) {
  process.on(sinal, () => {
    console.log(`[guardian] recebido ${sinal}, encerrando...`);
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}
