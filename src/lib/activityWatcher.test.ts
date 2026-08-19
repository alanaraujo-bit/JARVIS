import { beforeEach, describe, expect, it } from "vitest";

import { forgetSession, pollIdleTransitions, recordActivity, resetActivity } from "./activityWatcher";

describe("activityWatcher", () => {
  beforeEach(() => resetActivity());

  it("não dispara nada sem atividade", () => {
    expect(pollIdleTransitions(1_000_000)).toEqual([]);
  });

  it("dispara quando uma rajada relevante fica quieta", () => {
    recordActivity("s1", 50, 0);
    recordActivity("s1", 50, 900);
    // ainda em rajada (menos de 1500ms de silêncio)
    expect(pollIdleTransitions(1_000)).toEqual([]);
    // agora ficou quieta por tempo suficiente, e a rajada durou 900ms
    expect(pollIdleTransitions(900 + 1500)).toEqual(["s1"]);
  });

  it("não dispara duas vezes para a mesma rajada", () => {
    recordActivity("s1", 50, 0);
    recordActivity("s1", 50, 900);
    expect(pollIdleTransitions(2_500)).toEqual(["s1"]);
    expect(pollIdleTransitions(3_000)).toEqual([]);
  });

  it("ignora rajadas curtas demais (eco de tecla)", () => {
    recordActivity("s1", 5, 0);
    expect(pollIdleTransitions(1_600)).toEqual([]);
  });

  it("ignora rajadas pequenas em bytes mesmo se demoradas", () => {
    recordActivity("s1", 2, 0);
    recordActivity("s1", 2, 1000);
    expect(pollIdleTransitions(1000 + 1500)).toEqual([]);
  });

  it("uma rajada nova depois de notificar dispara de novo", () => {
    recordActivity("s1", 50, 0);
    recordActivity("s1", 50, 900);
    expect(pollIdleTransitions(2_500)).toEqual(["s1"]);

    recordActivity("s1", 50, 5_000);
    recordActivity("s1", 50, 5_900);
    expect(pollIdleTransitions(5_900 + 1500)).toEqual(["s1"]);
  });

  it("forgetSession limpa o estado", () => {
    recordActivity("s1", 50, 0);
    recordActivity("s1", 50, 900);
    forgetSession("s1");
    expect(pollIdleTransitions(2_500)).toEqual([]);
  });
});
