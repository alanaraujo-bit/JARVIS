/**
 * Persistência das contas do guardião.
 *
 * Um arquivo JSON (`dataDir/accounts.json`) com escrita atômica (temporário +
 * rename, o mesmo padrão do config do JARVIS). As credenciais são guardadas
 * **criptografadas**; o estado derivado (cota, próxima ação) fica em memória
 * e é reconstruído a cada ciclo do agendador — nunca é persistido, porque
 * envelhece em segundos.
 */

import fs from "node:fs";
import path from "node:path";

import { decrypt, encrypt } from "./crypto.js";
import type { UsageSnapshot } from "./anthropic.js";

/** Custo real vindo do JARVIS no PC (sincronizado enquanto o app está aberto). */
export interface CustoPc {
  costTotalUsd: number;
  costLast5hUsd: number;
  tokensLast5h: number;
  tokensLast24h: number;
  updatedAt: number;
}

export interface AccountRecord {
  id: string;
  name: string;
  /** Credenciais OAuth criptografadas (string opaca). */
  credentialsEnc: string;
  enabled: boolean;
  createdAt: number;
  /** Último custo sincronizado pelo PC. `null` = ainda não sincronizou. */
  custo: CustoPc | null;
}

/** Estado em memória de uma conta — o que o agendador mantém vivo. */
export interface AccountRuntime {
  /** Guardião não pinga enquanto `now < leaseUntil` (o usuário está usando). */
  leaseUntil: number;
  /** Próximo instante em que o agendador precisa olhar para esta conta. */
  nextActionAt: number;
  /**
   * Ping forçado (manual/teste — o botão "pingar agora" do painel). Faz o
   * agendador executar o ping no próximo ciclo mesmo com janela saudável.
   */
  forcePing: boolean;
  /** A janela de 5h estava cheia (>=95%) no último ciclo — para avisar quando liberar. */
  wasFull5h: boolean;
  /** Cota consultada por último. */
  usage: UsageSnapshot | null;
  /** Quando `usage` foi consultado. */
  usageAt: number;
  lastPingAt: number | null;
  lastPingOk: boolean | null;
  lastPingError: string | null;
  /** Flag de bloqueio por limite semanal (7d em 100%). */
  blockedWeekly: boolean;
  /** Flag de bloqueio por limite mensal de gasto. */
  blockedMonthly: boolean;
  /** Total de pings bem-sucedidos. */
  pingsOk: number;
  /** Total de pings falhos. */
  pingsFail: number;
}

export interface Account extends AccountRecord {
  runtime: AccountRuntime;
}

/** Inscrição de Web Push de um aparelho (o PWA do celular). */
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: number;
}

function validaId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 64 &&
    [...id].every((c) => /[A-Za-z0-9_-]/.test(c))
  );
}

export class Store {
  private accounts = new Map<string, Account>();
  private subs: PushSub[] = [];
  private readonly file: string;
  private readonly subsFile: string;
  private readonly secret: string;

  constructor(dataDir: string, secret: string) {
    this.file = path.join(dataDir, "accounts.json");
    this.subsFile = path.join(dataDir, "push-subs.json");
    this.secret = secret;
    fs.mkdirSync(dataDir, { recursive: true });
    this.load();
    this.loadSubs();
  }

  private loadSubs(): void {
    try {
      const raw = fs.readFileSync(this.subsFile, "utf8");
      const arr = JSON.parse(raw) as PushSub[];
      if (Array.isArray(arr)) this.subs = arr.filter((s) => s?.endpoint && s?.keys?.p256dh && s?.keys?.auth);
    } catch {
      /* primeira execução */
    }
  }

  private saveSubs(): void {
    const tmp = this.subsFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.subs, null, 2));
    fs.renameSync(tmp, this.subsFile);
  }

  listPushSubs(): PushSub[] {
    return [...this.subs];
  }

  addPushSub(sub: PushSub): void {
    this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint);
    this.subs.push(sub);
    // Limite de aparelhos: no máximo 20, mantendo os mais recentes.
    if (this.subs.length > 20) {
      this.subs.sort((a, b) => b.createdAt - a.createdAt);
      this.subs = this.subs.slice(0, 20);
    }
    this.saveSubs();
  }

  removePushSub(endpoint: string): void {
    const antes = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== antes) this.saveSubs();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return; // primeira execução: sem arquivo ainda
    }
    let records: AccountRecord[];
    try {
      records = JSON.parse(raw) as AccountRecord[];
    } catch {
      console.error("[guardian] accounts.json ilegível; começando do zero");
      return;
    }
    for (const r of records) {
      if (!validaId(r.id)) continue;
      this.accounts.set(r.id, {
        ...r,
        // Config de antes da sincronização de custo não tem o campo.
        custo: r.custo ?? null,
        runtime: novoRuntime(),
      });
    }
    console.log(`[guardian] ${this.accounts.size} conta(s) carregada(s)`);
  }

  private save(): void {
    const records: AccountRecord[] = [...this.accounts.values()].map((a) => ({
      id: a.id,
      name: a.name,
      credentialsEnc: a.credentialsEnc,
      enabled: a.enabled,
      createdAt: a.createdAt,
      custo: a.custo,
    }));
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list(): Account[] {
    return [...this.accounts.values()];
  }

  get(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  add(input: { id: string; name: string; credentialsJson: string; enabled?: boolean }): Account {
    if (!validaId(input.id)) throw new Error(`id de conta inválido: ${input.id}`);
    if (this.accounts.has(input.id)) throw new Error(`conta ${input.id} já existe`);
    const account: Account = {
      id: input.id,
      name: input.name.trim() || input.id,
      credentialsEnc: encrypt(input.credentialsJson, this.secret),
      enabled: input.enabled ?? true,
      createdAt: Date.now(),
      custo: null,
      runtime: novoRuntime(),
    };
    this.accounts.set(input.id, account);
    this.save();
    return account;
  }

  remove(id: string): void {
    this.accounts.delete(id);
    this.save();
  }

  /** Atualiza rótulos e/ou o estado habilitado. */
  update(id: string, patch: { enabled?: boolean; name?: string }): void {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`conta ${id} não existe`);
    if (patch.enabled !== undefined) a.enabled = patch.enabled;
    if (patch.name !== undefined && patch.name.trim()) a.name = patch.name.trim();
    this.save();
  }

  /**
   * Re-criptografa as credenciais da conta. Usado após um ping, quando a CLI
   * rotaciona o token e reescreve o `.credentials.json` de trabalho — sem isto
   * o store guardaria um refresh token morto e a conta quebraria num redeploy.
   */
  updateCredentials(id: string, credentialsJson: string): void {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`conta ${id} não existe`);
    a.credentialsEnc = encrypt(credentialsJson, this.secret);
    this.save();
  }

  /**
   * Atualiza o custo real da conta, como o JARVIS no PC envia de tempos em
   * tempos. `updatedAt` é marcado aqui no servidor: o relógio do guardião é
   * o que vale para o celular saber há quanto tempo os dados são frescos.
   */
  setCusto(id: string, custo: Omit<CustoPc, "updatedAt">): void {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`conta ${id} não existe`);
    a.custo = { ...custo, updatedAt: Date.now() };
    this.save();
  }

  /** Credenciais decifradas (para a CLI usar). Nunca logar isto. */
  credentials(a: Account): unknown {
    try {
      return JSON.parse(decrypt(a.credentialsEnc, this.secret));
    } catch {
      throw new Error(`não consegui decifrar as credenciais da conta ${a.id} (JARVIS_GUARDIAN_SECRET mudou?)`);
    }
  }
}

export function novoRuntime(): AccountRuntime {
  return {
    leaseUntil: 0,
    nextActionAt: 0,
    forcePing: false,
    wasFull5h: false,
    usage: null,
    usageAt: 0,
    lastPingAt: null,
    lastPingOk: null,
    lastPingError: null,
    blockedWeekly: false,
    blockedMonthly: false,
    pingsOk: 0,
    pingsFail: 0,
  };
}
