import { describe, expect, it } from "vitest";

import { contaDoConfigDir, explicaRetomada } from "./agentResume";
import type { AgentResume } from "./ipc";

const contas = [{ id: "acc-um" }, { id: "acc-dois" }];

function retomada(patch: Partial<AgentResume> = {}): AgentResume {
  return {
    kind: "claude",
    label: "Claude Code",
    sessionId: "abc",
    title: "arrumar o histórico",
    updatedAt: 1_700_000_000_000,
    command: "claude --resume abc",
    configDir: null,
    exact: true,
    ...patch,
  };
}

describe("contaDoConfigDir", () => {
  it("acha a conta pelo último trecho do caminho", () => {
    expect(
      contaDoConfigDir("C:\\Users\\a\\AppData\\Roaming\\JARVIS\\claude-accounts\\acc-dois", contas),
    ).toBe("acc-dois");
  });

  it("aceita barra normal e barra sobrando no fim", () => {
    expect(contaDoConfigDir("/home/a/.config/JARVIS/claude-accounts/acc-um/", contas)).toBe(
      "acc-um",
    );
  });

  it("sem pasta é a conta padrão da CLI, não uma conta forçada", () => {
    expect(contaDoConfigDir(null, contas)).toBeNull();
    expect(contaDoConfigDir(undefined, contas)).toBeNull();
  });

  it("pasta de uma conta que não existe mais no config não força nada", () => {
    // Forçar um id fantasma faria o terminal nascer numa pasta que ninguém
    // preparou — pior que cair na precedência normal de conta.
    expect(contaDoConfigDir("/x/claude-accounts/acc-apagada", contas)).toBeNull();
  });
});

describe("explicaRetomada", () => {
  it("promete a conversa exata quando o vínculo é do próprio JARVIS", () => {
    expect(explicaRetomada(retomada())).toContain("de onde parou");
  });

  it("avisa quando a conversa foi reconhecida por pasta e horário", () => {
    const texto = explicaRetomada(retomada({ exact: false }));
    expect(texto).toContain("pasta");
    expect(texto).not.toContain("de onde parou");
  });

  it("não inventa título quando o agente não guarda um", () => {
    expect(explicaRetomada(retomada({ title: null }))).toContain("a conversa");
  });
});
