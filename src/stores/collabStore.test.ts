import { describe, expect, it } from "vitest";

import { aplicaAi, type SharedAiMessage } from "./collabStore";

/**
 * A conversa com a IA chega ao convidado como uma sequência de eventos
 * soltos, e é o remontar deles que tem chance de errar — a tela só mostra o
 * resultado, então um pedaço perdido ou grudado no turno errado passa
 * despercebido até alguém reclamar que "a resposta veio embaralhada".
 */
describe("conversa com a IA na sala", () => {
  it("monta uma resposta a partir dos pedaços", () => {
    let lista: SharedAiMessage[] = [];
    lista = aplicaAi(lista, {
      k: "ask",
      requestId: "r1",
      authorName: "Primo",
      authorColor: "#a78bfa",
      text: "o que é esse erro?",
    });
    expect(lista).toHaveLength(1);
    expect(lista[0].streaming).toBe(true);
    expect(lista[0].answer).toBe("");

    lista = aplicaAi(lista, { k: "chunk", requestId: "r1", text: "É um " });
    lista = aplicaAi(lista, { k: "chunk", requestId: "r1", text: "erro de tipo." });
    expect(lista[0].answer).toBe("É um erro de tipo.");
    expect(lista[0].streaming).toBe(true);

    lista = aplicaAi(lista, { k: "done", requestId: "r1" });
    expect(lista[0].streaming).toBe(false);
    expect(lista[0].answer).toBe("É um erro de tipo.");
  });

  it("não mistura duas conversas que acontecem ao mesmo tempo", () => {
    // Duas pessoas perguntando junto é o caso normal numa sala, e os pedaços
    // chegam intercalados na mesma conexão.
    let lista: SharedAiMessage[] = [];
    lista = aplicaAi(lista, {
      k: "ask",
      requestId: "r1",
      authorName: "Primo",
      authorColor: "#a78bfa",
      text: "pergunta A",
    });
    lista = aplicaAi(lista, {
      k: "ask",
      requestId: "r2",
      authorName: "Alan",
      authorColor: "#5eead4",
      text: "pergunta B",
    });

    lista = aplicaAi(lista, { k: "chunk", requestId: "r2", text: "bbb" });
    lista = aplicaAi(lista, { k: "chunk", requestId: "r1", text: "aaa" });
    lista = aplicaAi(lista, { k: "chunk", requestId: "r2", text: "BBB" });

    expect(lista[0].answer).toBe("aaa");
    expect(lista[1].answer).toBe("bbbBBB");
    expect(lista[0].authorName).toBe("Primo");
    expect(lista[1].authorName).toBe("Alan");
  });

  it("um erro encerra só o turno que falhou", () => {
    let lista: SharedAiMessage[] = [];
    for (const id of ["r1", "r2"]) {
      lista = aplicaAi(lista, {
        k: "ask",
        requestId: id,
        authorName: "x",
        authorColor: "#fff",
        text: "?",
      });
    }
    lista = aplicaAi(lista, { k: "error", requestId: "r1", error: "sem chave de API" });

    expect(lista[0].error).toBe("sem chave de API");
    expect(lista[0].streaming).toBe(false);
    expect(lista[1].error).toBeUndefined();
    expect(lista[1].streaming).toBe(true);
  });

  it("pedaço de um turno desconhecido não cria conversa fantasma", () => {
    // Acontece de verdade: o convidado entra no meio de uma resposta que já
    // estava sendo gerada e recebe os pedaços sem ter visto a pergunta.
    const lista = aplicaAi([], { k: "chunk", requestId: "sumiu", text: "oi" });
    expect(lista).toHaveLength(0);
  });

  it("guarda só o rabo da conversa", () => {
    let lista: SharedAiMessage[] = [];
    for (let i = 0; i < 130; i++) {
      lista = aplicaAi(lista, {
        k: "ask",
        requestId: `r${i}`,
        authorName: "x",
        authorColor: "#fff",
        text: `p${i}`,
      });
    }
    expect(lista).toHaveLength(100);
    expect(lista[99].question).toBe("p129");
  });
});
