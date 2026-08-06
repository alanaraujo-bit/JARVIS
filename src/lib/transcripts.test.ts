import { describe, expect, it } from "vitest";

import type { TranscriptMeta } from "./ipc";
import {
  dayLabel,
  filterTranscripts,
  groupByDay,
  programName,
  sessionDuration,
  sessionLabel,
  shortenPath,
} from "./transcripts";

function meta(patch: Partial<TranscriptMeta> = {}): TranscriptMeta {
  return {
    id: "s1",
    title: "PowerShell 7",
    program: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    args: [],
    cwd: "C:\\Users\\alan\\Projetos\\JARVIS",
    profileId: "pwsh7",
    workspaceId: null,
    workspaceName: null,
    autoCommand: null,
    agentKind: null,
    agentSessionId: null,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    exitCode: null,
    truncated: false,
    bytes: 1024,
    ...patch,
  };
}

describe("programName", () => {
  it("tira caminho e extensão", () => {
    expect(programName("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh");
    expect(programName("/usr/bin/bash")).toBe("bash");
  });
});

describe("shortenPath", () => {
  it("troca a home por ~", () => {
    expect(shortenPath("C:\\Users\\alan\\Projetos")).toBe("~/Projetos");
  });

  it("mantém só as duas últimas pastas quando é fundo demais", () => {
    expect(shortenPath("C:\\Users\\alan\\a\\b\\c\\d")).toBe(".../c/d");
  });
});

describe("sessionLabel", () => {
  it("prefere a pasta ao shell — é ela que distingue uma sessão da outra", () => {
    expect(sessionLabel(meta())).toBe("JARVIS");
  });

  it("cai no título quando não há pasta reconhecível", () => {
    expect(sessionLabel(meta({ cwd: "" }))).toBe("PowerShell 7");
  });

  it("na home, o shell diz mais do que um '~' repetido em toda a lista", () => {
    expect(sessionLabel(meta({ cwd: "C:\\Users\\alan" }))).toBe("PowerShell 7");
  });
});

describe("sessionDuration", () => {
  it("não inventa duração para uma sessão que nunca foi encerrada", () => {
    expect(sessionDuration(meta({ endedAt: null }))).toBeNull();
  });

  it("escala de segundos a horas", () => {
    const t = 1_700_000_000_000;
    expect(sessionDuration(meta({ startedAt: t, endedAt: t + 42_000 }))).toBe("42s");
    expect(sessionDuration(meta({ startedAt: t, endedAt: t + 5 * 60_000 }))).toBe("5min");
    expect(sessionDuration(meta({ startedAt: t, endedAt: t + 125 * 60_000 }))).toBe("2h05");
  });
});

describe("dayLabel", () => {
  const agora = new Date(2026, 7, 5, 10, 0).getTime();

  it("nomeia hoje e ontem pela data local, não por 24h de distância", () => {
    // 23h de ontem está a 11h de distância, mas é outro dia — e é assim que
    // a pessoa procura.
    expect(dayLabel(new Date(2026, 7, 5, 0, 30).getTime(), agora)).toBe("Hoje");
    expect(dayLabel(new Date(2026, 7, 4, 23, 0).getTime(), agora)).toBe("Ontem");
  });

  it("usa a data para o resto", () => {
    expect(dayLabel(new Date(2026, 7, 1, 12, 0).getTime(), agora)).toMatch(/agosto/);
  });
});

describe("groupByDay", () => {
  it("agrupa preservando a ordem recebida", () => {
    const agora = new Date(2026, 7, 5, 10, 0).getTime();
    const grupos = groupByDay(
      [
        meta({ id: "a", startedAt: new Date(2026, 7, 5, 9, 0).getTime() }),
        meta({ id: "b", startedAt: new Date(2026, 7, 5, 8, 0).getTime() }),
        meta({ id: "c", startedAt: new Date(2026, 7, 4, 8, 0).getTime() }),
      ],
      agora,
    );

    expect(grupos.map((g) => g.label)).toEqual(["Hoje", "Ontem"]);
    expect(grupos[0].items.map((m) => m.id)).toEqual(["a", "b"]);
    expect(grupos[1].items.map((m) => m.id)).toEqual(["c"]);
  });
});

describe("filterTranscripts", () => {
  const lista = [
    meta({ id: "a", cwd: "C:\\Projetos\\JARVIS", autoCommand: "claude" }),
    meta({ id: "b", cwd: "C:\\Projetos\\RoHair", workspaceName: "RoHair" }),
    meta({ id: "c", cwd: "C:\\Projetos\\JARVIS", program: "bash.exe" }),
  ];

  it("acha pelo comando de auto-início, que não aparece escrito na lista", () => {
    expect(filterTranscripts(lista, "claude").map((m) => m.id)).toEqual(["a"]);
  });

  it("exige todos os termos — digitar mais estreita, não alarga", () => {
    expect(filterTranscripts(lista, "jarvis bash").map((m) => m.id)).toEqual(["c"]);
  });

  it("busca vazia devolve tudo", () => {
    expect(filterTranscripts(lista, "   ")).toHaveLength(3);
  });
});
