/**
 * O ping em si: roda a CLI do Claude Code em modo headless (`claude -p`)
 * apontando `CLAUDE_CONFIG_DIR` para o diretório da conta.
 *
 * É o mesmo mecanismo que o JARVIS usa nos terminais: a CLI resolve as
 * credenciais pelo diretório de config. Aqui rodamos numa pasta de trabalho
 * isolada por conta, com prompt mínimo e o modelo mais barato (haiku), e
 * parseamos o JSON de saída para classificar o resultado — sucesso, limite
 * semanal, limite mensal de gasto, sessão expirada ou erro genérico.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type PingBlock =
  | "ok"
  | "blocked_weekly"
  | "blocked_monthly"
  | "auth"
  | "rate_limited"
  | "error";

export interface PingResult {
  block: PingBlock;
  detail: string | null;
  sessionId: string | null;
}

export interface PingOptions {
  configDir: string;
  scratchDir: string;
  claudeBin: string;
  prompt: string;
  model: string;
  timeoutMs: number;
}

interface SaidaClaude {
  is_error?: boolean;
  api_error_status?: number;
  result?: string;
  session_id?: string;
  terminal_reason?: string;
}

export function runPing(opts: PingOptions): Promise<PingResult> {
  return new Promise((resolve) => {
    fs.mkdirSync(opts.scratchDir, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: opts.configDir,
      // HOME isolado: a CLI não polui a home real do container nem conflita
      // com a configuração padrão de outras coisas.
      HOME: opts.scratchDir,
    };

    const args = ["-p", opts.prompt, "--model", opts.model, "--output-format", "json"];
    const child = spawn(opts.claudeBin, args, { env, cwd: opts.scratchDir, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let finalizado = false;

    const finish = (r: PingResult) => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ block: "error", detail: `ping excedeu ${Math.round(opts.timeoutMs / 1000)}s`, sessionId: null });
    }, opts.timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      if (stdout.length > 200_000) {
        child.kill("SIGKILL");
        finish({ block: "error", detail: "saída da CLI grande demais", sessionId: null });
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on("error", (e) => finish({ block: "error", detail: `não consegui iniciar a CLI (${e.message})`, sessionId: null }));
    child.on("close", (code) => {
      const parsed = parseSaida(stdout);
      if (parsed) {
        finish(classifica(parsed, code));
        return;
      }
      const trecho = (stdout + "\n" + stderr).trim().slice(-500);
      finish({
        block: "error",
        detail: trecho ? `saída inesperada: ${trecho}` : `CLI encerrou com código ${code ?? "?"}`,
        sessionId: null,
      });
    });
  });
}

function parseSaida(stdout: string): SaidaClaude | null {
  // A CLI imprime logs antes do JSON; o JSON vem na última linha útil.
  const linhas = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = linhas.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(linhas[i]) as SaidaClaude;
      if (v && typeof v === "object" && "is_error" in v) return v;
    } catch {
      /* linha não-JSON: segue */
    }
  }
  return null;
}

function classifica(s: SaidaClaude, code: number | null): PingResult {
  const detail = s.result || s.terminal_reason || `código ${code ?? "?"}`;
  const sessionId = s.session_id ?? null;

  if (s.is_error === true) {
    const msg = (s.result ?? "").toLowerCase();
    const status = s.api_error_status;
    if (status === 429 && msg.includes("weekly")) {
      return { block: "blocked_weekly", detail: s.result ?? null, sessionId };
    }
    if (status === 429 && (msg.includes("monthly") || msg.includes("spend limit"))) {
      return { block: "blocked_monthly", detail: s.result ?? null, sessionId };
    }
    if (status === 429) {
      return { block: "rate_limited", detail: s.result ?? null, sessionId };
    }
    if (status === 401 || msg.includes("login") || msg.includes("expired")) {
      return { block: "auth", detail: s.result ?? null, sessionId };
    }
    return { block: "error", detail: s.result ?? s.terminal_reason ?? "erro da API", sessionId };
  }

  return { block: "ok", detail: null, sessionId };
}
