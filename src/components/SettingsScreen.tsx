/**
 * Configurações do JARVIS.
 *
 * Reúne o que antes vivia espalhado: aparência (tema e densidade, que ficavam
 * em botões de barra sem explicação), o Claude Code (modelo/esforço, que
 * morava só dentro das Estatísticas) e a central de atualizações (que era uma
 * sobreposição separada). Uma tela só, com cada assunto no seu lugar.
 *
 * A configuração de IA fica no painel do assistente (onde há espaço para
 * testar a conexão); aqui só há o atalho para chegar lá.
 */

import { useEffect, useRef } from "react";

import { Icon } from "./Icon";
import { ClaudeConfigForm } from "./ClaudeConfigForm";
import { useUiStore } from "../stores/uiStore";
import { useAccountStore } from "../stores/accountStore";
import { useAiStore } from "../stores/aiStore";
import { useUpdateStore } from "../stores/updateStore";
import type { ThemeMode } from "../lib/theme";
import type { Density } from "../stores/uiStore";

const TEMAS: { valor: ThemeMode; rotulo: string }[] = [
  { valor: "system", rotulo: "Sistema" },
  { valor: "dark", rotulo: "Escuro" },
  { valor: "light", rotulo: "Claro" },
];

const DENSIDADES: { valor: Density; rotulo: string }[] = [
  { valor: "cozy", rotulo: "Confortável" },
  { valor: "compact", rotulo: "Compacta" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenContas: () => void;
  onOpenAtualizacoes: () => void;
  onReabrirIntroducao: () => void;
}

export function SettingsScreen({
  open,
  onClose,
  onOpenContas,
  onOpenAtualizacoes,
  onReabrirIntroducao,
}: Props) {
  const caixaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) caixaRef.current?.focus();
  }, [open]);

  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);

  const contas = useAccountStore((s) => s.contas);
  const padraoId = useAccountStore((s) => s.padraoId);
  const statusContas = useAccountStore((s) => s.status);
  const aiConfig = useAiStore((s) => s.config);
  const setAiPanelOpen = useAiStore((s) => s.setPanelOpen);
  const toggleAiSettings = useAiStore((s) => s.toggleSettings);

  const versaoAtual = useUpdateStore((s) => s.versaoAtual);
  const updateFase = useUpdateStore((s) => s.fase);

  if (!open) return null;

  // Pasta da conta padrão para o formulário do Claude Code — a mesma
  // precedência que o painel de Estatísticas usa.
  const dirDoFormulario = padraoId ? statusContas[padraoId]?.configDir : undefined;

  return (
    <div className="stats-backdrop" onMouseDown={onClose}>
      <div
        className="stats settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
        tabIndex={-1}
        ref={caixaRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="stats-header">
          <span>Configurações</span>
          <button
            className="stats-close"
            onClick={onClose}
            title="Fechar (Esc)"
            aria-label="Fechar configurações"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        {/* Aparência */}
        <div className="stats-section">
          <h3>Aparência</h3>
          <div className="settings-row">
            <div className="settings-block">
              <span className="settings-label">Tema</span>
              <div className="settings-pills">
                {TEMAS.map((t) => (
                  <button
                    key={t.valor}
                    className={`chip ${themeMode === t.valor ? "chip-on" : ""}`}
                    onClick={() => setThemeMode(t.valor)}
                    aria-pressed={themeMode === t.valor}
                  >
                    {t.rotulo}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-block">
              <span className="settings-label">Densidade</span>
              <div className="settings-pills">
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
            </div>
          </div>
        </div>

        {/* Claude Code */}
        <div className="stats-section">
          <h3>Claude Code</h3>
          <ClaudeConfigForm configDir={dirDoFormulario} />
          <div className="settings-link-row">
            <span>
              {contas.length === 0
                ? "Sem contas cadastradas — os terminais usam o login normal."
                : `${contas.length} conta(s) cadastrada(s).`}
            </span>
            <button className="chip subtle" onClick={onOpenContas}>
              <Icon name="coins" size={13} />
              Gerenciar contas
            </button>
          </div>
        </div>

        {/* Assistente IA */}
        <div className="stats-section">
          <h3>Assistente IA</h3>
          <div className="settings-link-row">
            <span className="settings-current">
              {aiConfig.provider} · {aiConfig.model}
            </span>
            <button
              className="chip"
              onClick={() => {
                setAiPanelOpen(true);
                toggleAiSettings();
                onClose();
              }}
            >
              <Icon name="spark" size={13} />
              Configurar IA
            </button>
          </div>
        </div>

        {/* Atualizações */}
        <div className="stats-section">
          <h3>Atualizações</h3>
          <div className="settings-link-row">
            <span className="settings-current">
              {versaoAtual ? `v${versaoAtual}` : "Versão desconhecida"}
              {updateFase === "disponivel" && " — há uma versão nova!"}
              {updateFase === "pronto" && " — reinicie para aplicar"}
            </span>
            <button className="chip subtle" onClick={onOpenAtualizacoes}>
              <Icon name="refresh" size={13} />
              Ver detalhes
            </button>
          </div>
        </div>

        {/* Introdução */}
        <div className="stats-section">
          <h3>Introdução</h3>
          <div className="settings-link-row">
            <span className="settings-current">Reveja a apresentação inicial.</span>
            <button className="chip subtle" onClick={onReabrirIntroducao}>
              <Icon name="logo" size={13} />
              Ver de novo
            </button>
          </div>
        </div>

        <p className="stats-note">
          Tema e densidade também têm atalhos na barra de cima. O modelo e o esforço do
          Claude Code valem para a próxima vez que a CLI <code>claude</code> for iniciada.
        </p>
      </div>
    </div>
  );
}
