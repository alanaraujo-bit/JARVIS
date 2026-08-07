/**
 * As teclas que o teclado do celular não tem.
 *
 * Sem esta barra o app seria uma demonstração bonita e inútil: `Esc`, `Tab`,
 * as setas e o `Ctrl` são justamente o que se usa para conversar com o Claude
 * Code — navegar opção, completar caminho, subir no histórico, interromper.
 * Um teclado de celular não oferece nenhuma delas.
 *
 * Duas decisões que parecem detalhe e não são:
 *
 * - **`preventDefault` no `pointerdown`.** Sem isso, tocar numa tecla tira o
 *   foco do terminal, o teclado do sistema fecha e a tela pula. Cancelar o
 *   evento antes de ele virar foco mantém o cursor onde estava, e a barra
 *   passa a se comportar como uma extensão do teclado em vez de um botão de
 *   página.
 * - **`Ctrl` é pega-e-solta, não segura.** Ninguém consegue segurar uma tecla
 *   com o polegar e digitar com o mesmo polegar. Ela fica armada e some na
 *   tecla seguinte, que é como todo teclado de celular trata `Shift`.
 */

import { useState } from "react";

interface Tecla {
  rotulo: string;
  seq: string;
  largo?: boolean;
}

/** Ordem escolhida pelo polegar: o que mais se usa fica mais perto da borda. */
const PRINCIPAIS: Tecla[] = [
  { rotulo: "Esc", seq: "\x1b" },
  { rotulo: "Tab", seq: "\t" },
  { rotulo: "↑", seq: "\x1b[A" },
  { rotulo: "↓", seq: "\x1b[B" },
  { rotulo: "←", seq: "\x1b[D" },
  { rotulo: "→", seq: "\x1b[C" },
  { rotulo: "^C", seq: "\x03" },
];

const EXTRAS: Tecla[] = [
  { rotulo: "⇧Tab", seq: "\x1b[Z" },
  { rotulo: "^D", seq: "\x04" },
  { rotulo: "^Z", seq: "\x1a" },
  { rotulo: "^L", seq: "\x0c" },
  { rotulo: "^R", seq: "\x12" },
  { rotulo: "Home", seq: "\x1b[H" },
  { rotulo: "End", seq: "\x1b[F" },
  { rotulo: "PgUp", seq: "\x1b[5~" },
  { rotulo: "PgDn", seq: "\x1b[6~" },
  { rotulo: "|", seq: "|" },
  { rotulo: "~", seq: "~" },
  { rotulo: "/", seq: "/" },
  { rotulo: "\\", seq: "\\" },
  { rotulo: "-", seq: "-" },
  { rotulo: "_", seq: "_" },
];

export interface Props {
  onTecla: (seq: string) => void;
  ctrlArmado: boolean;
  onCtrl: () => void;
  desativada: boolean;
}

export function BarraTeclas({ onTecla, ctrlArmado, onCtrl, desativada }: Props) {
  const [abertas, setAbertas] = useState(false);

  const segurarFoco = (e: React.PointerEvent) => e.preventDefault();

  const botao = (t: Tecla) => (
    <button
      key={t.rotulo}
      className="tecla"
      disabled={desativada}
      onPointerDown={segurarFoco}
      onClick={() => onTecla(t.seq)}
    >
      {t.rotulo}
    </button>
  );

  return (
    <div className="barra-teclas">
      {abertas && <div className="teclas-linha extras">{EXTRAS.map(botao)}</div>}
      <div className="teclas-linha">
        <button
          className={`tecla mod ${ctrlArmado ? "armada" : ""}`}
          disabled={desativada}
          onPointerDown={segurarFoco}
          onClick={onCtrl}
          aria-pressed={ctrlArmado}
        >
          Ctrl
        </button>
        {PRINCIPAIS.map(botao)}
        <button
          className={`tecla mais ${abertas ? "armada" : ""}`}
          onPointerDown={segurarFoco}
          onClick={() => setAbertas((v) => !v)}
          aria-label="Mais teclas"
        >
          {abertas ? "×" : "⋯"}
        </button>
      </div>
    </div>
  );
}
