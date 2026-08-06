/**
 * Menu de navegação do JARVIS — a grade vertical à esquerda.
 *
 * É o que faltava para o app ter um começo: antes, todo caminho vivia num
 * atalho de teclado ou num botão de barra, e quem abria o app pela primeira
 * vez caía direto nos terminais sem mapa nenhum. Aqui o ponto de partida é
 * sempre visível — Início, Estatísticas, Histórico, Contas, Configurações e
 * Perfil — com o item ativo marcado e a marca do app no topo.
 *
 * Design: a largura expande com rótulos em janela larga e encolhe para
 * ícones em janela estreita (onde sobra pouco espaço para o terminal). O
 * rótulo nunca some de verdade: em modo ícone ele vira tooltip próprio
 * (`aria-label`), então a navegação continua legível para leitor de tela.
 */

import { usePointerGlow } from "../hooks/usePointerGlow";
import { useUpdateStore } from "../stores/updateStore";
import { Icon, type IconName } from "./Icon";

/** Destinos que a grade pode abrir. */
export type RailDest =
  | "home"
  | "stats"
  | "history"
  | "accounts"
  | "settings"
  | "profile";

interface NavRailProps {
  active: RailDest;
  onSelect: (dest: RailDest) => void;
}

interface Item {
  dest: RailDest;
  icon: IconName;
  label: string;
  hint: string;
  group: "principal" | "sistema";
}

const ITENS: Item[] = [
  {
    dest: "home",
    icon: "home",
    label: "Início",
    hint: "Seus terminais e workspaces",
    group: "principal",
  },
  {
    dest: "stats",
    icon: "activity",
    label: "Estatísticas",
    hint: "Uso de terminais e do Claude Code",
    group: "principal",
  },
  {
    dest: "history",
    icon: "history",
    label: "Histórico",
    hint: "Sessões gravadas, prontas para reler",
    group: "principal",
  },
  {
    dest: "accounts",
    icon: "coins",
    label: "Contas",
    hint: "Contas do Claude Code",
    group: "sistema",
  },
  {
    dest: "settings",
    icon: "settings",
    label: "Configurações",
    hint: "Aparência, IA e atualizações",
    group: "sistema",
  },
  {
    dest: "profile",
    icon: "user",
    label: "Perfil",
    hint: "Esta máquina e o seu JARVIS",
    group: "sistema",
  },
];

export function NavRail({ active, onSelect }: NavRailProps) {
  const versao = useUpdateStore((s) => s.versaoAtual);
  const glowRef = usePointerGlow<HTMLDivElement>();

  return (
    <nav className="nav-rail" aria-label="Menu principal">
      <div className="nav-rail-brand">
        <span className="nav-rail-logo">
          <Icon name="logo" size={22} />
        </span>
        <span className="nav-rail-wordmark">JARVIS</span>
      </div>

      <div className="nav-rail-items fluid-list" ref={glowRef}>
        {ITENS.map((item, i) => (
          <div key={item.dest}>
            {i > 0 && item.group !== ITENS[i - 1].group && (
              <div className="nav-rail-sep" aria-hidden="true" />
            )}
            <button
              className={`nav-item ${active === item.dest ? "active" : ""}`}
              onClick={() => onSelect(item.dest)}
              aria-label={item.label}
              aria-current={active === item.dest ? "page" : undefined}
              title={item.label}
            >
              <Icon name={item.icon} size={18} />
              <span className="nav-item-text">
                <span className="nav-item-label">{item.label}</span>
                <span className="nav-item-hint">{item.hint}</span>
              </span>
            </button>
          </div>
        ))}
      </div>

      <div className="nav-rail-footer">
        {versao && <span className="nav-rail-version">v{versao}</span>}
      </div>
    </nav>
  );
}
