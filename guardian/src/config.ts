/**
 * Configuração do guardião, toda por variáveis de ambiente (Railway-friendly).
 * Nada de segredo vive em arquivo: token de API e chave de criptografia vêm
 * do ambiente, e o resto tem padrões seguros.
 */

export interface Config {
  port: number;
  dataDir: string;
  /** Token de autenticação da API REST (Bearer). */
  authToken: string;
  /** Chave usada para criptografar as credenciais em repouso (AES-256-GCM). */
  secret: string;
  /**
   * Margem de precisão do agendamento. O guardião só manda um "oi" novo
   * quando a janela de 5h está a menos de `pingMarginMs` de expirar — e o
   * próximo ciclo é agendado exatamente para `resets_at + pingMarginMs`.
   * Padrão: 60s (o "três horas e um minuto" do pedido).
   */
  pingMarginMs: number;
  /**
   * Trava de segurança: nunca pingar a mesma conta mais de uma vez a cada
   * intervalo mínimo, mesmo que o estado pareça pedir. Evita loop se a API
   * de cota devolver dados incoerentes.
   */
  minPingIntervalMs: number;
  /** De quanto em quanto tempo o laço do agendador acorda para conferir. */
  loopIntervalMs: number;
  /** Depois de quanto tempo uma cota consultada é considerada velha. */
  usageStaleMs: number;
  /** Modelo usado nos pings — o mais barato/leve disponível. */
  pingModel: string;
  /** Texto do ping. Curto e inócuo de propósito. */
  pingPrompt: string;
  /** Binário da CLI do Claude Code. */
  claudeBin: string;
  /** Timeout de um ping (a CLI pode demorar para subir no servidor). */
  pingTimeoutMs: number;
  /** Timeout da consulta de cota. */
  usageTimeoutMs: number;
  /** Percentual que dispara o aviso de "cota acabando". */
  usageAlertPercent: number;
  /** Chaves VAPID para Web Push (notificações no celular). Vazio = push desligado. */
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
}

function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 3000),
    dataDir: env.DATA_DIR ?? "./data",
    authToken: env.JARVIS_GUARDIAN_TOKEN ?? "",
    secret: env.JARVIS_GUARDIAN_SECRET ?? "",
    pingMarginMs: num(env.PING_MARGIN_MS, 60_000),
    minPingIntervalMs: num(env.MIN_PING_INTERVAL_MS, 10 * 60_000),
    loopIntervalMs: num(env.LOOP_INTERVAL_MS, 15_000),
    usageStaleMs: num(env.USAGE_STALE_MS, 5 * 60_000),
    pingModel: env.PING_MODEL ?? "haiku",
    pingPrompt: env.PING_PROMPT ?? "oi",
    claudeBin: env.CLAUDE_BIN ?? "claude",
    pingTimeoutMs: num(env.PING_TIMEOUT_MS, 150_000),
    usageTimeoutMs: num(env.USAGE_TIMEOUT_MS, 8_000),
    usageAlertPercent: num(env.USAGE_ALERT_PERCENT, 70),
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? "",
    vapidPrivateKey: env.VAPID_PRIVATE_KEY ?? "",
    vapidSubject: env.VAPID_SUBJECT ?? "mailto:jarvis@localhost",
  };
}
