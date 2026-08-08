/**
 * API REST do guardião + servir o PWA estático.
 *
 * Rotas (todas com `Authorization: Bearer <JARVIS_GUARDIAN_TOKEN>`, exceto a
 * página e o health):
 *   GET  /api/health               -> está vivo?
 *   GET  /api/status               -> estado de todas as contas
 *   POST /api/accounts             -> registra conta { id, name, credentialsJson }
 *   DELETE /api/accounts/:id       -> remove conta
 *   PATCH /api/accounts/:id        -> { enabled } ou { name }
 *   POST /api/accounts/:id/lease   -> heartbeat "estou usando esta conta" (JARVIS)
 *   POST /api/accounts/:id/ping    -> força um ping agora (teste/manual)
 *   POST /api/accounts/:id/usage   -> custo real em $ sincronizado pelo PC
 *   DELETE /api/accounts/:id/usage -> limpa o custo sincronizado (reset)
 *
 * Nenhuma rota devolve token: credenciais entram, nunca saem.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import type { Config } from "./config.js";
import type { Account, Store } from "./store.js";
import { Scheduler } from "./scheduler.js";

export class ApiServer {
  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly scheduler: Scheduler,
  ) {}

  start(): http.Server {
    const server = http.createServer((req, res) => this.handle(req, res));
    server.listen(this.cfg.port, () => {
      console.log(`[guardian] API escutando na porta ${this.cfg.port}`);
    });
    return server;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const rota = url.pathname;

      // Health e chave pública VAPID são públicos (o PWA precisa da chave
      // antes de ter token para se inscrever).
      if (req.method === "GET" && rota === "/api/health") {
        this.json(res, 200, { ok: true, agora: Date.now() });
        return;
      }
      if (req.method === "GET" && rota === "/api/push/vapid") {
        this.json(res, 200, { publicKey: this.cfg.vapidPublicKey || null });
        return;
      }

      // Tudo que começa com /api exige token. A página `/` (e o resto do
      // estático) é pública por necessidade: é a tela que o celular abre
      // antes de digitar o token.
      if (!rota.startsWith("/api/")) {
        this.estatico(req, res, rota);
        return;
      }

      if (!this.autorizado(req)) {
        this.json(res, 401, { error: "token inválido" });
        return;
      }

      if (req.method === "GET" && rota === "/api/status") {
        this.json(res, 200, {
          agora: Date.now(),
          contas: this.store.list().map((a) => this.visao(a)),
        });
        return;
      }

      if (req.method === "POST" && rota === "/api/accounts") {
        void this.lerJson(req).then((body) => {
          const id = String(body?.id ?? "");
          const name = String(body?.name ?? "");
          const credentialsJson = String(body?.credentialsJson ?? "");
          if (!credentialsJson.trim()) {
            this.json(res, 400, { error: "credentialsJson é obrigatório" });
            return;
          }
          try {
            // Valida que é JSON antes de guardar.
            JSON.parse(credentialsJson);
            const conta = this.store.add({ id, name, credentialsJson });
            this.json(res, 201, { conta: this.visao(conta) });
          } catch (e) {
            this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        });
        return;
      }

      const mDel = rota.match(/^\/api\/accounts\/([^/]+)$/);
      if (mDel && (req.method === "DELETE" || req.method === "PATCH")) {
        // Ids de conta são e-mails (têm `@`), então o JARVIS manda URL-encoded
        // e `URL.pathname` mantém o `%40` — sem decodificar aqui, todo
        // lease/ping/usage de conta real daria 404 silencioso.
        const id = descodifica(mDel[1]);
        if (req.method === "DELETE") {
          this.store.remove(id);
          this.json(res, 200, { ok: true });
          return;
        }
        void this.lerJson(req).then((body) => {
          try {
            const patch: { enabled?: boolean; name?: string } = {};
            if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
            if (typeof body?.name === "string") patch.name = body.name;
            this.store.update(id, patch);
            this.json(res, 200, { ok: true });
          } catch (e) {
            this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        });
        return;
      }

      const mUso = rota.match(/^\/api\/accounts\/([^/]+)\/usage$/);
      if (mUso && (req.method === "POST" || req.method === "DELETE")) {
        const id = descodifica(mUso[1]);
        if (req.method === "DELETE") {
          // Limpeza manual: apaga o custo sincronizado (dados de teste ou
          // errados). O próximo sync do PC repõe sozinho.
          try {
            this.store.clearCusto(id);
            this.json(res, 200, { ok: true });
          } catch (e) {
            this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }
        // Custo real vindo do JARVIS no PC (nunca exposto de volta). O
        // celular mostra na tela de estatísticas junto com a cota ao vivo.
        void this.lerJson(req).then((body) => {
          const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          try {
            this.store.setCusto(id, {
              costTotalUsd: num(body?.costTotalUsd),
              costLast5hUsd: num(body?.costLast5hUsd),
              tokensLast5h: num(body?.tokensLast5h),
              tokensLast24h: num(body?.tokensLast24h),
            });
            this.json(res, 200, { ok: true });
          } catch (e) {
            this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        });
        return;
      }

      const mPing = rota.match(/^\/api\/accounts\/([^/]+)\/ping$/);
      if (mPing && req.method === "POST") {
        const conta = this.store.get(descodifica(mPing[1]));
        if (!conta) {
          this.json(res, 404, { error: "conta não existe" });
          return;
        }
        // Força de verdade: ignora o estado da janela no próximo ciclo.
        conta.runtime.forcePing = true;
        conta.runtime.nextActionAt = 0;
        conta.runtime.usageAt = 0;
        this.json(res, 202, { ok: true, mensagem: "ping forçado no próximo ciclo" });
        return;
      }

      if (rota === "/api/push/subscribe") {
        if (req.method === "POST") {
          void this.lerJson(req).then((body) => {
            const sub = body?.subscription as
              | { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
              | undefined;
            if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth || !sub.endpoint.startsWith("https://")) {
              this.json(res, 400, { error: "subscription inválida" });
              return;
            }
            this.store.addPushSub({
              endpoint: sub.endpoint,
              keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
              createdAt: Date.now(),
            });
            this.json(res, 200, { ok: true });
          });
          return;
        }
        if (req.method === "DELETE") {
          void this.lerJson(req).then((body) => {
            const endpoint = String(body?.endpoint ?? "");
            if (!endpoint) {
              this.json(res, 400, { error: "endpoint é obrigatório" });
              return;
            }
            this.store.removePushSub(endpoint);
            this.json(res, 200, { ok: true });
          });
          return;
        }
        this.json(res, 405, { error: "método não suportado" });
        return;
      }

      const mLease = rota.match(/^\/api\/accounts\/([^/]+)\/lease$/);
      if (mLease && req.method === "POST") {
        const conta = this.store.get(descodifica(mLease[1]));
        if (!conta) {
          this.json(res, 404, { error: "conta não existe" });
          return;
        }
        // 2 minutos de folga; o JARVIS renova a cada ~1 min enquanto houver
        // terminal aberto na conta.
        conta.runtime.leaseUntil = Date.now() + 2 * 60_000;
        this.json(res, 200, { ok: true, leaseUntil: conta.runtime.leaseUntil });
        return;
      }

      if (req.method === "GET" && rota.startsWith("/api/")) {
        this.json(res, 404, { error: "rota não existe" });
        return;
      }

      this.json(res, 405, { error: "método não suportado" });
    } catch (e) {
      this.json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Visão pública de uma conta: nunca inclui credenciais nem tokens. */
  private visao(a: Account): Record<string, unknown> {
    const rt = a.runtime;
    return {
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      createdAt: a.createdAt,
      custo: a.custo,
      estado: {
        leaseAtivo: Date.now() < rt.leaseUntil,
        bloqueadaSemanal: rt.blockedWeekly,
        bloqueadaMensal: rt.blockedMonthly,
        cota: rt.usage
          ? {
              ok: rt.usage.ok,
              erro: rt.usage.error ?? null,
              fiveHour: rt.usage.fiveHour,
              sevenDay: rt.usage.sevenDay,
              limites: rt.usage.limits,
            }
          : null,
        cotaConsultadaEm: rt.usageAt || null,
        ultimoPing: rt.lastPingAt,
        ultimoPingOk: rt.lastPingOk,
        ultimoPingErro: rt.lastPingError,
        pingsOk: rt.pingsOk,
        pingsFail: rt.pingsFail,
        proximaAcaoEm: rt.nextActionAt || null,
      },
    };
  }

  private autorizado(req: http.IncomingMessage): boolean {
    const h = req.headers.authorization ?? "";
    const esperado = `Bearer ${this.cfg.authToken}`;
    const ok = h === esperado;
    if (!ok) {
      // Comparação em tempo constante não importa aqui (token curto), mas o
      // log não pode ecoar o header — evita vazar o token por acidente.
      console.log("[guardian] requisição sem autorização válida");
    }
    return ok;
  }

  private estatico(req: http.IncomingMessage, res: http.ServerResponse, rota: string): void {
    const raiz = path.resolve(process.cwd(), "public");
    const alvo = rota === "/" ? "/index.html" : rota;
    const caminho = path.normalize(path.join(raiz, alvo));
    // `raiz + sep` (e não só `raiz`): `/app/public2/...` é irmão, não filho.
    if (!caminho.startsWith(raiz + path.sep)) {
      this.json(res, 403, { error: "fora do diretório público" });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(caminho);
    } catch {
      this.json(res, 404, { error: "não encontrado" });
      return;
    }
    const tipo = mime(caminho);
    const cabecalhos: Record<string, string> = {
      "Content-Type": tipo,
      "Cache-Control": "no-cache",
    };
    if (tipo.startsWith("text/html")) {
      cabecalhos["Content-Security-Policy"] =
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'";
    }
    res.writeHead(200, cabecalhos);
    res.end(bytes);
  }

  private lerJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let corpo = "";
      req.on("data", (d: Buffer) => {
        corpo += d.toString("utf8");
        if (corpo.length > 2_000_000) {
          req.destroy();
          resolve(null);
        }
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(corpo) as Record<string, unknown>);
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const texto = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(texto);
  }
}

/** Decodifica um id de conta vindo da URL (o JARVIS envia e-mails URL-encoded). */
function descodifica(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg; // malformado: deixa como veio, o store devolve 404
  }
}

function mime(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    case ".webmanifest": return "application/manifest+json";
    default: return "application/octet-stream";
  }
}
