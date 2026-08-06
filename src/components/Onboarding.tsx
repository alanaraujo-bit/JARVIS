/**
 * Introdução de primeira execução.
 *
 * A primeira impressão do app. Antes disso, quem abria o JARVIS caía direto
 * num terminal vazio — e o app tinha atalhos de teclado escondidos em
 * lugar nenhum. A introdução faz o papel de anfitriã: apresenta a marca,
 * deixa a pessoa escolher o tema na hora (a escolha fica aplicada e salva,
 * não é um preview descartável) e mostra os três gestos que mais se usa.
 *
 * Um detalhe de fluxo: a tela só é mostrada quando o config em disco diz que
 * a introdução ainda não foi vista (`ui.onboardingDone === false`). O app
 * inteiro segue montando por trás — o terminal, os workspaces, tudo — e a
 * introdução flutua por cima. Terminar (ou pular) é só um sinalizador no
 * config; nada precisa ser re-inicializado.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";
import { useUiStore, type Density } from "../stores/uiStore";
import type { ThemeMode } from "../lib/theme";

const PASSOS = ["Boas-vindas", "Aparência", "Atalhos"];

const TEMAS: { valor: ThemeMode; rotulo: string; descricao: string }[] = [
  { valor: "system", rotulo: "Seguir o sistema", descricao: "Acompanha o tema do Windows" },
  { valor: "dark", rotulo: "Escuro", descricao: "O conforto de sempre à noite" },
  { valor: "light", rotulo: "Claro", descricao: "Para ambientes bem iluminados" },
];

const DENSIDADES: { valor: Density; rotulo: string; descricao: string }[] = [
  { valor: "cozy", rotulo: "Confortável", descricao: "Respira, com folga entre linhas" },
  { valor: "compact", rotulo: "Compacta", descricao: "Mais linhas visíveis de terminal" },
];

const ATALHOS: { tecla: string; acao: string }[] = [
  { tecla: "Ctrl+Shift+T", acao: "Nova aba de terminal" },
  { tecla: "Ctrl+Shift+P", acao: "Paleta de comandos" },
  { tecla: "Ctrl+Shift+I", acao: "JARVIS AI" },
  { tecla: "Ctrl+Shift+B", acao: "Workspaces" },
];

export function Onboarding() {
  const [passo, setPasso] = useState(0);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);
  const setOnboardingDone = useUiStore((s) => s.setOnboardingDone);

  const caixaRef = useRef<HTMLDivElement | null>(null);

  // Foco na caixa ao abrir, para o Esc ter onde cair.
  useEffect(() => {
    caixaRef.current?.focus();
  }, []);

  const terminar = useCallback(() => setOnboardingDone(true), [setOnboardingDone]);

  const proximo = useCallback(() => {
    setPasso((p) => (p + 1 >= PASSOS.length ? p : p + 1));
  }, []);

  const voltar = useCallback(() => {
    setPasso((p) => (p === 0 ? p : p - 1));
  }, []);

  const noTeclado = useCallback(
    (e: React.KeyboardEvent) => {
      // Esc pula a introdução inteira.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        terminar();
        return;
      }
      // Enter avança de passo — mas só fora de um controle interativo. Com
      // o foco num cartão de tema ou numa pastilha, o Enter deve ativar o
      // controle (selecionar), não pular o slide por cima da escolha.
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        if (passo >= PASSOS.length - 1) terminar();
        else proximo();
      }
    },
    [passo, proximo, terminar],
  );

  return (
    <div
      className="onboarding"
      role="dialog"
      aria-modal="true"
      aria-label="Bem-vindo ao JARVIS"
    >
      <div className="onboarding-glow" aria-hidden="true" />
      <div
        className="onboarding-card"
        ref={caixaRef}
        tabIndex={-1}
        onKeyDown={noTeclado}
      >
        <div className="onboarding-steps" aria-hidden="true">
          {PASSOS.map((nome, i) => (
            <span
              key={nome}
              className={`onboarding-step ${i <= passo ? "done" : ""}`}
              title={nome}
            />
          ))}
        </div>

        <div className="onboarding-body">
          {passo === 0 && (
            <section className="onboarding-slide" key="0">
              <div className="onboarding-logo">
                <Icon name="logo" size={44} />
              </div>
              <h1>Bem-vindo ao JARVIS</h1>
              <p className="onboarding-lead">
                Sua central de terminais, agentes de IA e projetos — tudo em um
                lugar só, com a sua cara.
              </p>
              <ul className="onboarding-features">
                <li>
                  <Icon name="terminal" size={15} />
                  Terminais com histórico gravado e divisões de tela
                </li>
                <li>
                  <Icon name="spark" size={15} />
                  JARVIS AI conversando com o seu terminal
                </li>
                <li>
                  <Icon name="folder" size={15} />
                  Workspaces que guardam pasta, shell e conta
                </li>
              </ul>
              <div className="onboarding-actions">
                <button className="chip onboarding-primary" onClick={proximo}>
                  Começar
                </button>
              </div>
            </section>
          )}

          {passo === 1 && (
            <section className="onboarding-slide" key="1">
              <h2>Aparência</h2>
              <p className="onboarding-lead">
                Escolha como o JARVIS se veste. Isso fica salvo — dá para mudar
                quando quiser na barra de cima ou nas Configurações.
              </p>

              <div className="onboarding-temas">
                {TEMAS.map((t) => (
                  <button
                    key={t.valor}
                    className={`onboarding-card-btn ${themeMode === t.valor ? "selected" : ""}`}
                    onClick={() => setThemeMode(t.valor)}
                  >
                    <span className="onboarding-card-preview">
                      <span className={`preview preview-${t.valor}`}>
                        <i />
                        <i />
                        <i />
                      </span>
                    </span>
                    <span className="onboarding-card-label">{t.rotulo}</span>
                    <span className="onboarding-card-desc">{t.descricao}</span>
                  </button>
                ))}
              </div>

              <div className="onboarding-densidades">
                <span className="onboarding-field-label">Densidade</span>
                <div className="onboarding-pills">
                  {DENSIDADES.map((d) => (
                    <button
                      key={d.valor}
                      className={`chip ${density === d.valor ? "chip-on" : ""}`}
                      onClick={() => setDensity(d.valor)}
                      aria-pressed={density === d.valor}
                    >
                      {d.rotulo}
                    </button>
                  ))}
                </div>
                <p className="onboarding-hint">
                  {DENSIDADES.find((d) => d.valor === density)?.descricao}
                </p>
              </div>

              <div className="onboarding-actions">
                <button className="chip subtle" onClick={voltar}>
                  Voltar
                </button>
                <button className="chip onboarding-primary" onClick={proximo}>
                  Continuar
                </button>
              </div>
            </section>
          )}

          {passo === 2 && (
            <section className="onboarding-slide" key="2">
              <h2>Atalhos que valem ouro</h2>
              <p className="onboarding-lead">
                O JARVIS é feito para quem vive no teclado. Estes três abrem
                quase tudo que o app faz:
              </p>
              <ul className="onboarding-atalhos">
                {ATALHOS.map((a) => (
                  <li key={a.tecla}>
                    <kbd>{a.tecla}</kbd>
                    <span>{a.acao}</span>
                  </li>
                ))}
              </ul>
              <div className="onboarding-actions">
                <button className="chip subtle" onClick={voltar}>
                  Voltar
                </button>
                <button className="chip onboarding-primary" onClick={terminar}>
                  Entrar no JARVIS
                </button>
              </div>
            </section>
          )}
        </div>

        <button className="onboarding-skip" onClick={terminar}>
          Pular introdução
        </button>
      </div>
    </div>
  );
}
