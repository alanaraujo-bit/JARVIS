import { describe, expect, it } from "vitest";

import type { SessionInfo } from "./ipc";
import { computeStats, formatBytes, formatDuration } from "./stats";

function sessao(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "PowerShell",
    program: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    args: [],
    cwd: "C:\\",
    cols: 80,
    rows: 24,
    profileId: "pwsh7",
    pid: 100,
    startedAt: 1_000,
    alive: true,
    exitCode: null,
    bytesOut: 0,
    bytesIn: 0,
    jobbed: true,
    ...patch,
  };
}

describe("computeStats", () => {
  it("soma os contadores de todas as sessões, vivas ou mortas", () => {
    const s = computeStats([
      sessao({ id: "a", bytesOut: 100, bytesIn: 10 }),
      sessao({ id: "b", bytesOut: 50, bytesIn: 5, alive: false }),
    ]);
    expect(s.totalSessions).toBe(2);
    expect(s.aliveSessions).toBe(1);
    expect(s.bytesOut).toBe(150);
    expect(s.bytesIn).toBe(15);
  });

  it("mede o tempo ativo só das sessões vivas", () => {
    const s = computeStats(
      [
        sessao({ id: "viva", startedAt: 1_000 }),
        // Mais antiga, mas morta: não deve ganhar o "maior tempo ativo".
        sessao({ id: "morta", startedAt: 0, alive: false }),
      ],
      11_000,
    );
    expect(s.longestUptimeMs).toBe(10_000);
  });

  it("não produz tempo ativo negativo se o relógio andou para trás", () => {
    const s = computeStats([sessao({ startedAt: 50_000 })], 10_000);
    expect(s.longestUptimeMs).toBe(0);
  });

  it("agrupa por perfil e ordena do mais usado para o menos", () => {
    const s = computeStats([
      sessao({ id: "a", profileId: "pwsh7", bytesOut: 10 }),
      sessao({ id: "b", profileId: "pwsh7", bytesOut: 10 }),
      sessao({ id: "c", profileId: "gitbash", bytesOut: 90 }),
    ]);
    expect(s.byShell.map((g) => g.label)).toEqual(["pwsh7", "gitbash"]);
    expect(s.byShell[0].sessions).toBe(2);
    expect(s.byShell[1].bytesOut).toBe(90);
  });

  it("cai no nome do executável quando a sessão não tem perfil", () => {
    const s = computeStats([sessao({ profileId: null })]);
    expect(s.byShell[0].label).toBe("pwsh.exe");
  });

  it("devolve zeros sem sessão nenhuma", () => {
    const s = computeStats([]);
    expect(s).toMatchObject({ totalSessions: 0, aliveSessions: 0, longestUptimeMs: 0 });
    expect(s.byShell).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("mostra bytes crus abaixo de 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
  });

  it("sobe de unidade e larga a casa decimal quando o número cresce", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 20)).toBe("20 KB");
    expect(formatBytes(1024 * 1024 * 3.5)).toBe("3.5 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });

  it("não quebra com entrada inválida", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  it("escolhe a maior unidade que ainda faz sentido", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(90_000)).toBe("1min");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_600_000 + 14 * 60_000)).toBe("1h 14min");
  });
});
