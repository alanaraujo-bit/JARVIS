/**
 * O coração do guardião: o agendador inteligente.
 *
 * Regra de ouro (o "preciso, não pode errar" do pedido): o guardião só manda
 * um "oi" quando a janela de 5h não existe (conta ociosa há tempo) ou está a
 * menos de `pingMarginMs` de expirar. Enquanto a janela existe, ele **dorme
 * exatamente até `resets_at + margem`** e agenda o próximo ciclo para lá —
 * nunca pinga antes, nunca gasta ping à toa, nunca deixa a janela morrer por
 * mais que a margem.
 *
 * E nunca pinga quando:
 *  - o usuário está usando a conta (lease/heartbeat do JARVIS);
 *  - a janela semanal (7d) está em 100% (travada — o ping falharia);
 *  - a conta está com limite mensal de gasto atingido;
 *  - já pingou há menos que `minPingIntervalMs` (trava anti-loop).
 */

import fs from "node:fs";
import path from "node:path";

import { blockedWeekly, fetchUsage, weeklyResetsAtMs, type UsageSnapshot } from "./anthropic.js";
import { runPing } from "./pinger.js";
import type { Config } from "./config.js";
import type { Account, JanelaAlerta, Store } from "./store.js";

export type GuardianEvent =
  | { t: "ping_ok"; accountId: string }
  | { t: "ping_fail"; accountId: string; reason: string }
  | { t: "blocked_weekly"; accountId: string; resetsAtMs: number }
  | { t: "weekly_freed"; accountId: string }
  | { t: "blocked_monthly"; accountId: string }
  | { t: "auth_error"; accountId: string }
  | { t: "window_freed"; accountId: string }
  | { t: "usage_warning"; accountId: string; janela: JanelaAlerta; percent: number }
  | { t: "usage_restored"; accountId: string; janela: JanelaAlerta };

export class Scheduler {
  private running = false;
  private pinging = false;

  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
    private readonly onEvent: (e: GuardianEvent) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const inicio = Date.now();
      try {
        await this.tick();
      } catch (e) {
        console.error("[guardian] erro no ciclo:", e instanceof Error ? e.message : e);
      }
      const decorrido = Date.now() - inicio;
      await sleep(Math.max(500, this.cfg.loopIntervalMs - decorrido));
    }
  }

  private async tick(): Promise<void> {
    const agora = Date.now();
    for (const account of this.store.list()) {
      if (!account.enabled) continue;
      const rt = account.runtime;
      // Duas razões para processar: chegou a hora da ação agendada, ou a cota
      // que temos em mãos envelheceu — se o usuário usou a conta por fora
      // (CLI direta, outro PC), o reset dela mudou e o ping agendado na hora
      // antiga seria desperdício. Contas bloqueadas não reconsultam: elas só
      // acordam no reset agendado, e é de propósito.
      const pausado = rt.blockedWeekly || rt.blockedMonthly;
      const cotaVelha = agora - rt.usageAt > this.cfg.usageStaleMs;
      if (agora < rt.nextActionAt && !(cotaVelha && !pausado)) continue;

      if (!rt.usage || cotaVelha) {
        rt.usage = await this.consultaCota(account);
        rt.usageAt = agora;
      }
      if (!rt.usage?.ok) {
        // Sessão inválida (401/403) ou ping manual: o ping é o ÚNICO jeito de
        // renovar o token OAuth — a CLI faz o refresh e o
        // `sincronizaCredenciais` grava o token novo. Sem isto, conta com
        // sessão velha ficaria presa em "sem cota" para sempre: o `decide()`
        // (onde o ping acontece) nunca roda com cota quebrada.
        const status = rt.usage?.httpStatus ?? null;
        // Sessão em uso ativo mantém o token fresco — o guardião nunca pinga
        // conta que o usuário está usando (mesma regra do `decide()`).
        const livre = agora >= rt.leaseUntil;
        if (rt.forcePing || (livre && (status === 401 || status === 403))) {
          rt.forcePing = false;
          await this.pingSePuder(account, agora);
        } else if (status === 429) {
          // Rate limit da Anthropic: re-bater em 60s só piora. Recua 5 min.
          rt.nextActionAt = agora + 5 * 60_000;
        } else if (rt.usage) {
          rt.nextActionAt = agora + Math.min(60_000, this.cfg.usageStaleMs);
        }
        // `rt.usage === null` (credenciais ausentes/indecifráveis): mantém o
        // backoff de 10 min que a `consultaCota` já agendou — sobrescrever
        // com 60s faria o `auth_error` (e o log) disparar a cada minuto.
        continue;
      }
      await this.decide(account, agora);
    }
  }

  private async consultaCota(account: Account): Promise<UsageSnapshot | null> {
    let creds: { claudeAiOauth?: { accessToken?: string } };
    try {
      creds = this.store.credentials(account) as typeof creds;
    } catch (e) {
      // Só avisa uma vez a cada 10 min: sem isso, credencial corrompida
      // (ex.: JARVIS_GUARDIAN_SECRET trocada) viraria log a cada ciclo.
      this.onEvent({ t: "auth_error", accountId: account.id });
      account.runtime.nextActionAt = Date.now() + 10 * 60_000;
      return null;
    }
    const token = creds.claudeAiOauth?.accessToken;
    if (!token) {
      this.onEvent({ t: "auth_error", accountId: account.id });
      account.runtime.nextActionAt = Date.now() + 10 * 60_000;
      return null;
    }
    return fetchUsage(token, this.cfg.usageTimeoutMs);
  }

  private async decide(account: Account, agora: number): Promise<void> {
    const rt = account.runtime;
    const usage = rt.usage!;

    // Alertas de consumo e de retorno para as duas janelas. A Store persiste
    // as transições: uma reinicialização não reenvia o mesmo push.
    this.observaAlertas(account, usage);

    // 1) Bloqueio mensal de gasto: pausa total até desbloqueio manual.
    if (rt.blockedMonthly || usage.spendLimitReached) {
      if (!rt.blockedMonthly) {
        rt.blockedMonthly = true;
        this.onEvent({ t: "blocked_monthly", accountId: account.id });
      }
      rt.nextActionAt = agora + 6 * 60 * 60_000;
      return;
    }
    if (rt.blockedMonthly) rt.blockedMonthly = false;

    // 2) Bloqueio semanal (7d em 100%): não pingar; acordar no reset semanal.
    if (blockedWeekly(usage)) {
      if (!rt.blockedWeekly) {
        rt.blockedWeekly = true;
        const resets = weeklyResetsAtMs(usage);
        if (resets) this.onEvent({ t: "blocked_weekly", accountId: account.id, resetsAtMs: resets });
      } else {
        // Se estava travada e o reset já passou, o "liberou" é notificado
        // pela transição abaixo (blockedWeekly deixa de ser verdade).
      }
      rt.nextActionAt = (weeklyResetsAtMs(usage) ?? agora + 60 * 60_000) + this.cfg.pingMarginMs;
      return;
    }
    if (rt.blockedWeekly) {
      rt.blockedWeekly = false;
      this.onEvent({ t: "weekly_freed", accountId: account.id });
    }

    // 2.1) Aviso de "janela liberou": estava cheia (>=95%) e agora não está
    // mais. É o aviso que o usuário quer no celular: "pode usar de novo".
    const fhCorrente = usage.fiveHour;
    const cheia =
      !!fhCorrente &&
      fhCorrente.utilization !== null &&
      fhCorrente.utilization >= 95 &&
      fhCorrente.resetsAtMs !== null &&
      fhCorrente.resetsAtMs > agora;
    if (!cheia && rt.wasFull5h) {
      rt.wasFull5h = false;
      this.onEvent({ t: "window_freed", accountId: account.id });
    } else {
      rt.wasFull5h = cheia;
    }

    // 3) Usuário usando a conta: o lease manda — nada de ping, nada de sono.
    if (agora < rt.leaseUntil) {
      rt.nextActionAt = rt.leaseUntil + 1000;
      return;
    }

    // 3.1) Ping forçado (manual/teste): ignora o estado da janela.
    if (rt.forcePing) {
      rt.forcePing = false;
      await this.pingSePuder(account, agora);
      return;
    }

    // 4) Janela de 5h: decide se está na hora do próximo "oi".
    // A janela "existe" quando `resets_at` está no futuro — a utilização
    // pode ser 0,0% mesmo com a janela viva, porque um "oi" minúsculo
    // arredonda para zero. Antes, `utilization <= 0` era tratado como "sem
    // janela" e o guardião pingava a conta a cada 10 min à toa, num loop
    // que nunca enxergava a janela que ele mesmo estava renovando.
    const fh = usage.fiveHour;
    const resetsAt = fh ? fh.resetsAtMs : null;
    if (!fh || resetsAt === null || resetsAt <= agora) {
      // Sem janela (conta ociosa) ou já expirada: hora de (re)começar.
      await this.pingSePuder(account, agora);
      return;
    }

    const falta = resetsAt - agora;
    if (falta <= this.cfg.pingMarginMs) {
      await this.pingSePuder(account, agora);
      return;
    }

    // Precisão: o próximo ciclo desta conta é exatamente no reset + margem.
    // (O tick global ainda acorda antes se a cota ficar velha e mudar.)
    rt.nextActionAt = resetsAt + this.cfg.pingMarginMs;
  }

  private observaAlertas(account: Account, usage: UsageSnapshot): void {
    const janelas: [JanelaAlerta, typeof usage.fiveHour][] = [
      ["fiveHour", usage.fiveHour],
      ["sevenDay", usage.sevenDay],
    ];
    for (const [janela, info] of janelas) {
      if (!info) continue;
      const eventos = this.store.observaAlerta(
        account.id,
        janela,
        info.utilization,
        info.resetsAtMs,
        this.cfg.usageAlertPercent,
      );
      for (const evento of eventos) {
        if (evento === "warning") {
          this.onEvent({ t: "usage_warning", accountId: account.id, janela, percent: info.utilization ?? this.cfg.usageAlertPercent });
        } else {
          this.onEvent({ t: "usage_restored", accountId: account.id, janela });
        }
      }
    }
  }

  /**
   * Dispara um ping sem travar o laço. O ping em si roda numa task à parte
   * (`rodaPing`); aqui só se prepara o terreno: um ping por vez, respeito ao
   * intervalo mínimo e a **cópia de trabalho** das credenciais — a CLI lê
   * `$CLAUDE_CONFIG_DIR/.credentials.json`, e esse arquivo precisa existir
   * no diretório da conta antes do `claude -p` subir.
   */
  private async pingSePuder(account: Account, agora: number): Promise<void> {
    const rt = account.runtime;
    if (this.pinging) {
      // Um ping por vez (a CLI é pesada); o laço segue livre e a conta é
      // reprocessada no próximo tick.
      rt.nextActionAt = agora + this.cfg.loopIntervalMs;
      return;
    }
    const ultimoPing = rt.lastPingAt ?? 0;
    if (agora - ultimoPing < this.cfg.minPingIntervalMs) {
      rt.nextActionAt = ultimoPing + this.cfg.minPingIntervalMs;
      return;
    }

    let creds: { claudeAiOauth?: { accessToken?: string } };
    try {
      creds = this.store.credentials(account) as typeof creds;
    } catch (e) {
      this.onEvent({ t: "auth_error", accountId: account.id });
      rt.nextActionAt = agora + 10 * 60_000;
      return;
    }

    const dirConta = path.join(this.cfg.dataDir, "accounts", account.id);
    const scratch = path.join(this.cfg.dataDir, "scratch", account.id);
    try {
      fs.mkdirSync(dirConta, { recursive: true });
      fs.writeFileSync(path.join(dirConta, ".credentials.json"), JSON.stringify(creds), {
        mode: 0o600,
      });
    } catch (e) {
      this.onEvent({
        t: "ping_fail",
        accountId: account.id,
        reason: `não consegui preparar as credenciais: ${e instanceof Error ? e.message : e}`,
      });
      rt.nextActionAt = agora + 10 * 60_000;
      return;
    }

    this.pinging = true;
    // Segurança enquanto o ping voa: se algo der errado, o ciclo volta a
    // olhar para esta conta depois do timeout do ping.
    rt.nextActionAt = agora + this.cfg.pingTimeoutMs + 5_000;
    void this.rodaPing(account, agora, dirConta, scratch);
  }

  /** O ping em si, fora do laço — fire-and-forget, nunca pode derrubar o processo. */
  private async rodaPing(account: Account, inicio: number, dirConta: string, scratch: string): Promise<void> {
    try {
      const res = await runPing({
        configDir: dirConta,
        scratchDir: scratch,
        claudeBin: this.cfg.claudeBin,
        prompt: this.cfg.pingPrompt,
        model: this.cfg.pingModel,
        timeoutMs: this.cfg.pingTimeoutMs,
      });

      // A CLI pode ter rotacionado o token e reescrito o arquivo de trabalho:
      // sincroniza de volta (criptografado) para sobreviver a redeploys.
      this.sincronizaCredenciais(account, dirConta);

      const rt = account.runtime;
      rt.lastPingAt = inicio;
      if (res.block === "ok") {
        rt.pingsOk += 1;
        rt.lastPingOk = true;
        rt.lastPingError = null;
        this.onEvent({ t: "ping_ok", accountId: account.id });
        // O ping criou/renovou a janela: cota velha agora mente — força nova
        // leitura no próximo tick e agenda o reset lá.
        rt.usageAt = 0;
        rt.nextActionAt = Date.now() + this.cfg.loopIntervalMs;
        return;
      }

      rt.pingsFail += 1;
      rt.lastPingOk = false;
      rt.lastPingError = res.detail ?? res.block;
      switch (res.block) {
        case "blocked_weekly":
          rt.blockedWeekly = true;
          this.onEvent({ t: "blocked_weekly", accountId: account.id, resetsAtMs: 0 });
          rt.nextActionAt = Date.now() + 60 * 60_000;
          break;
        case "blocked_monthly":
          rt.blockedMonthly = true;
          this.onEvent({ t: "blocked_monthly", accountId: account.id });
          rt.nextActionAt = Date.now() + 6 * 60 * 60_000;
          break;
        case "auth":
          this.onEvent({ t: "auth_error", accountId: account.id });
          rt.nextActionAt = Date.now() + 60 * 60_000;
          break;
        default:
          this.onEvent({ t: "ping_fail", accountId: account.id, reason: res.detail ?? res.block });
          rt.nextActionAt = Date.now() + 10 * 60_000; // backoff
      }
    } catch (e) {
      console.error("[guardian] erro inesperado no ping:", e instanceof Error ? e.message : e);
    } finally {
      this.pinging = false;
    }
  }

  /** Re-lê o `.credentials.json` de trabalho e atualiza o store se mudou. */
  private sincronizaCredenciais(account: Account, dirConta: string): void {
    try {
      const novo = fs.readFileSync(path.join(dirConta, ".credentials.json"), "utf8");
      if (novo) this.store.updateCredentials(account.id, novo);
    } catch {
      // Arquivo ausente ou ilegível: nada a sincronizar.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
