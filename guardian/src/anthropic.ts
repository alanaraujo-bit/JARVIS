/**
 * Cliente da API de cota real da Anthropic — o mesmo endpoint que a CLI
 * `claude` consulta em `/usage` (espelho do `claude_usage_live.rs` do JARVIS).
 *
 * O token OAuth vem das credenciais da conta; nada de segredo sai daqui.
 * A resposta nos dá as janelas de 5h e 7 dias com o instante exato de reset —
 * é isso que alimenta o agendador inteligente.
 */

const URL_USAGE = "https://api.anthropic.com/api/oauth/usage";
const BETA_USAGE = "oauth-2025-04-20";
// A Anthropic coloca requisições sem User-Agent de CLI num bucket de
// rate-limit agressivo (429) — ferramentas de terceiros quebraram por causa
// disto em 2026. Imitar o formato da CLI evita esse balde.
const USER_AGENT = "claude-code/2.1.4";

export interface WindowInfo {
  utilization: number | null;
  resetsAtMs: number | null;
}

export interface LimitInfo {
  kind: string;
  percent: number;
  resetsAtMs: number | null;
  isActive: boolean;
}

export interface UsageSnapshot {
  ok: boolean;
  error?: string;
  httpStatus: number | null;
  fiveHour: WindowInfo | null;
  sevenDay: WindowInfo | null;
  limits: LimitInfo[];
  spendLimitReached: boolean;
}

function janela(v: unknown): WindowInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const util = typeof o.utilization === "number" ? o.utilization : null;
  const resets = typeof o.resets_at === "string" ? Date.parse(o.resets_at) : null;
  return {
    utilization: util,
    resetsAtMs: Number.isFinite(resets as number) ? (resets as number) : null,
  };
}

export async function fetchUsage(accessToken: string, timeoutMs: number): Promise<UsageSnapshot> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(URL_USAGE, {
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": BETA_USAGE,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, httpStatus: res.status, error: "sessão expirada — rode /login no Claude Code desta conta", fiveHour: null, sevenDay: null, limits: [], spendLimitReached: false };
    }
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, error: `a Anthropic respondeu ${res.status}`, fiveHour: null, sevenDay: null, limits: [], spendLimitReached: false };
    }
    const body = (await res.json()) as Record<string, unknown>;

    const limits: LimitInfo[] = Array.isArray(body.limits)
      ? (body.limits as Record<string, unknown>[]).map((l) => {
          const resets = typeof l.resets_at === "string" ? Date.parse(l.resets_at) : null;
          return {
            kind: String(l.kind ?? "?"),
            percent: typeof l.percent === "number" ? l.percent : 0,
            resetsAtMs: Number.isFinite(resets as number) ? (resets as number) : null,
            isActive: l.is_active === true,
          };
        })
      : [];

    const extra = body.extra_usage as Record<string, unknown> | null | undefined;
    return {
      ok: true,
      httpStatus: res.status,
      fiveHour: janela(body.five_hour),
      sevenDay: janela(body.seven_day),
      limits,
      spendLimitReached: extra?.spend_limit_reached === true,
    };
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError"
      ? `sem resposta da Anthropic em ${Math.round(timeoutMs / 1000)}s`
      : e instanceof Error ? e.message : String(e);
    return { ok: false, httpStatus: null, error: msg, fiveHour: null, sevenDay: null, limits: [], spendLimitReached: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Percentual de uso semanal >= 100 => conta travada pelo limite semanal. */
export function blockedWeekly(s: UsageSnapshot): boolean {
  const sd = s.sevenDay;
  if (sd && sd.utilization !== null && sd.utilization >= 99.95) return true;
  return s.limits.some((l) => l.kind === "weekly_all" && l.isActive && l.percent >= 99.95);
}

/** Instante em que o limite semanal zera (para agendar o "acordar"). */
export function weeklyResetsAtMs(s: UsageSnapshot): number | null {
  if (s.sevenDay?.resetsAtMs) return s.sevenDay.resetsAtMs;
  const l = s.limits.find((x) => x.kind === "weekly_all");
  return l?.resetsAtMs ?? null;
}
