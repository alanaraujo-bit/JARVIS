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
    case "usage_warning": return `conta ${e.accountId} atingiu ${Math.round(e.percent)}% na janela ${e.janela}`;
    case "usage_restored": return `cota da janela ${e.janela} da conta ${e.accountId} retornou`;
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
function avisa(chave: string, cooldownMs: number, titulo: string, corpo: string, tipo: string): void {
  const agora = Date.now();
  const ultimo = ultimoAviso.get(chave) ?? 0;
  if (agora - ultimo < cooldownMs) return;
  ultimoAviso.set(chave, agora);
  void notifier.notify(titulo, corpo, tipo);
}

const nome = (id: string): string => store.get(id)?.name ?? id;

const scheduler = new Scheduler(store, cfg, (e) => {
  console.log(`[guardian] ${descreve(e)}`);
  switch (e.t) {
    case "ping_ok":
      // Pedido explícito: cada "oi" bem-sucedido é um marco útil. Ele
      // confirma que a conta saiu do repouso ou que sua janela de 5h foi
      // renovada sem depender do PC estar ligado.
      void notifier.notify(
        "⚡ JARVIS · Conta acordada",
        `Conta "${nome(e.accountId)}": oi enviado com sucesso; a janela de 5h foi iniciada ou renovada.`,
        "ping",
      );
      break;
    case "ping_fail":
      avisa(`falha:${e.accountId}`, 30 * 60_000, "🔴 JARVIS · Ping falhou", `Conta "${nome(e.accountId)}": ${e.reason}`, "error");
      break;
    case "blocked_weekly": {
      // Fuso explícito: o servidor roda em US East; o usuário está em São Paulo.
      const data = e.resetsAtMs
        ? new Date(e.resetsAtMs).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
        : "em breve";
      avisa(`semanal:${e.accountId}`, 6 * 60 * 60_000, "⛔ JARVIS · Conta travada", `Conta "${nome(e.accountId)}" travada no limite semanal — libera ${data}.`, "blocked");
      break;
    }
    case "weekly_freed":
      avisa(`liberou:${e.accountId}`, 6 * 60 * 60_000, "🟢 JARVIS · Conta liberada", `Conta "${nome(e.accountId)}" liberou o limite semanal.`, "restored");
      break;
    case "blocked_monthly":
      avisa(`mensal:${e.accountId}`, 12 * 60 * 60_000, "⛔ JARVIS · Limite mensal", `Conta "${nome(e.accountId)}" atingiu o limite mensal de gasto.`, "blocked");
      break;
    case "auth_error":
      avisa(`auth:${e.accountId}`, 2 * 60 * 60_000, "🔐 JARVIS · Sessão inválida", `Conta "${nome(e.accountId)}" precisa de /login no Claude Code.`, "error");
      break;
    case "window_freed":
      avisa(`janela:${e.accountId}`, 30 * 60_000, "🟢 JARVIS · Janela liberada", `Janela de 5h da conta "${nome(e.accountId)}" liberou.`, "restored");
      break;
    case "usage_warning": {
      const janela = e.janela === "fiveHour" ? "5h" : "7 dias";
      avisa(
        `uso:${e.accountId}:${e.janela}`,
        6 * 60 * 60_000,
        "🟡 JARVIS · Cota acabando",
        `Conta "${nome(e.accountId)}" chegou a ${Math.round(e.percent)}% na janela de ${janela}.`,
        "warning",
      );
      break;
    }
    case "usage_restored": {
      const janela = e.janela === "fiveHour" ? "5h" : "7 dias";
      avisa(
        `retorno:${e.accountId}:${e.janela}`,
        30 * 60_000,
        "🟢 JARVIS · Cota voltou",
        `A janela de ${janela} da conta "${nome(e.accountId)}" voltou a ter cota disponível.`,
        "restored",
      );
      break;
    }
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
