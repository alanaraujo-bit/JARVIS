import { describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeInput,
  inviteUrl,
  normalizeAddress,
  normalizeCode,
  OP_DATA,
  OP_INPUT,
} from "./collabProtocol";

/** Monta um quadro igual ao que o Rust envia, para conferir a leitura. */
function quadroDoAnfitriao(op: number, id: string, seq: bigint, payload: Uint8Array): ArrayBuffer {
  const idBytes = new TextEncoder().encode(id);
  const buf = new ArrayBuffer(2 + idBytes.length + 8 + payload.length);
  const view = new Uint8Array(buf);
  view[0] = op;
  view[1] = idBytes.length;
  view.set(idBytes, 2);
  new DataView(buf).setBigUint64(2 + idBytes.length, seq);
  view.set(payload, 2 + idBytes.length + 8);
  return buf;
}

describe("quadros binários", () => {
  it("lê um lote de saída de PTY do jeito que o Rust manda", () => {
    const buf = quadroDoAnfitriao(OP_DATA, "sessao-abc", 1234n, new Uint8Array([1, 2, 3]));
    const q = decodeFrame(buf);
    expect(q).not.toBeNull();
    expect(q!.op).toBe(OP_DATA);
    expect(q!.sessionId).toBe("sessao-abc");
    expect(q!.seq).toBe(1234);
    expect([...q!.payload]).toEqual([1, 2, 3]);
  });

  it("não perde precisão num contador acima de 4 GB", () => {
    // O `seq` é o total acumulado de bytes da sessão. Um `npm run dev` que
    // ficou dias no ar passa de 2^32 sem esforço, e ler o contador como dois
    // inteiros de 32 bits truncaria — o corte entre instantâneo e fluxo ao
    // vivo passaria a errar por gigabytes.
    const grande = 8_589_934_592n; // 8 GiB
    const q = decodeFrame(quadroDoAnfitriao(OP_DATA, "s", grande, new Uint8Array()));
    expect(q!.seq).toBe(8_589_934_592);
  });

  it("devolve null para quadro truncado em vez de lançar", () => {
    expect(decodeFrame(new ArrayBuffer(0))).toBeNull();
    expect(decodeFrame(new ArrayBuffer(1))).toBeNull();
    // Tamanho de id maior do que o quadro inteiro.
    const curto = new Uint8Array([OP_DATA, 200, 65]);
    expect(decodeFrame(curto.buffer)).toBeNull();
    // Id completo, mas sem os 8 bytes do contador.
    const semSeq = new Uint8Array([OP_DATA, 1, 65, 0, 0]);
    expect(decodeFrame(semSeq.buffer)).toBeNull();
  });

  it("empacota a entrada no formato que o anfitrião lê", () => {
    const q = encodeInput("abc", new Uint8Array([108, 115, 13]));
    expect(q[0]).toBe(OP_INPUT);
    expect(q[1]).toBe(3);
    expect(new TextDecoder().decode(q.subarray(2, 5))).toBe("abc");
    expect([...q.subarray(5)]).toEqual([108, 115, 13]);
  });

  it("aguenta ida e volta de bytes que não são texto", () => {
    // Sequências ANSI e relatos de mouse não são UTF-8 válido; o caminho
    // binário existe justamente para não passar por string em ponto nenhum.
    const cru = new Uint8Array([0x1b, 0x5b, 0x41, 0xff, 0x00, 0xfe]);
    const q = decodeFrame(quadroDoAnfitriao(OP_DATA, "s", 6n, cru));
    expect([...q!.payload]).toEqual([...cru]);
  });
});

describe("endereço da sala", () => {
  it("aceita o que já é WebSocket", () => {
    expect(normalizeAddress("ws://192.168.0.10:7391")).toBe("ws://192.168.0.10:7391");
    expect(normalizeAddress("wss://algo.trycloudflare.com")).toBe("wss://algo.trycloudflare.com");
  });

  it("converte o endereço do túnel, que a pessoa copia do navegador", () => {
    expect(normalizeAddress("https://abc-def.trycloudflare.com")).toBe(
      "wss://abc-def.trycloudflare.com",
    );
    expect(normalizeAddress("http://exemplo.com:8080")).toBe("ws://exemplo.com:8080");
  });

  it("escolhe o esquema pelo formato quando não há nenhum", () => {
    // IP é rede local: texto puro. Domínio veio de um túnel: TLS.
    expect(normalizeAddress("192.168.0.10:7391")).toBe("ws://192.168.0.10:7391");
    expect(normalizeAddress("localhost:7391")).toBe("ws://localhost:7391");
    expect(normalizeAddress("abc.trycloudflare.com")).toBe("wss://abc.trycloudflare.com");
  });

  it("ignora espaço em volta e recusa vazio", () => {
    expect(normalizeAddress("  ws://a:1  ")).toBe("ws://a:1");
    expect(normalizeAddress("   ")).toBeNull();
    expect(normalizeAddress("")).toBeNull();
  });
});

describe("código da sala", () => {
  it("aceita o código como a pessoa digita", () => {
    // Estes três são o mesmo código: ditado por telefone, colado do chat e
    // digitado com pressa.
    expect(normalizeCode("ab2c3d4e")).toBe("AB2C-3D4E");
    expect(normalizeCode("AB2C-3D4E")).toBe("AB2C-3D4E");
    expect(normalizeCode(" ab2c 3d4e ")).toBe("AB2C-3D4E");
  });

  it("não inventa hífen num código de tamanho errado", () => {
    expect(normalizeCode("AB2C")).toBe("AB2C");
    expect(normalizeCode("AB2C3D4E5F")).toBe("AB2C3D4E5F");
  });

  it("bate com a normalização do backend", () => {
    // O Rust faz exatamente isto em `collab::normaliza_codigo`. Se as duas
    // divergirem, o código certo passa a ser recusado e não há nenhuma
    // mensagem de erro que explique o porquê.
    expect(normalizeCode("a-b-2-c-3-d-4-e")).toBe("AB2C-3D4E");
  });
});

describe("convite para o celular", () => {
  it("vira um endereço que o navegador abre", () => {
    // A sala guarda `ws://`/`wss://` porque é isso que o convidado do desktop
    // consome; o QR precisa de algo que uma câmera de celular saiba abrir.
    expect(inviteUrl("wss://abc.trycloudflare.com", "AB2C-3D4E")).toBe(
      "https://abc.trycloudflare.com/#c=AB2C-3D4E",
    );
    expect(inviteUrl("ws://192.168.0.10:7391", "AB2C-3D4E")).toBe(
      "http://192.168.0.10:7391/#c=AB2C-3D4E",
    );
  });

  it("leva o código no fragmento, e não numa query", () => {
    // O navegador não envia o fragmento ao servidor: o código não entra em
    // log de acesso, de proxy nem do túnel. Numa query, entraria nos três.
    const url = inviteUrl("wss://x.trycloudflare.com", "AB2C-3D4E")!;
    expect(url).toContain("#c=");
    expect(url).not.toContain("?");
  });

  it("normaliza o código antes de colocá-lo no link", () => {
    expect(inviteUrl("wss://x.com", "ab2c3d4e")).toBe("https://x.com/#c=AB2C-3D4E");
  });

  it("não duplica a barra de um endereço que já termina com uma", () => {
    expect(inviteUrl("wss://x.com/", "AB2C-3D4E")).toBe("https://x.com/#c=AB2C-3D4E");
  });

  it("sem endereço não há convite", () => {
    // Acontece de verdade: máquina sem rede e túnel desligado.
    expect(inviteUrl(null, "AB2C-3D4E")).toBeNull();
  });
});
