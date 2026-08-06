/**
 * Menu de navegação do JARVIS — a grade vertical à esquerda.
 *
 * É o que faltava para o app ter um começo: antes, todo caminho vivia num
 * atalho de teclado ou num botão de barra, e quem abria o app pela primeira
 * vez caía direto nos terminais sem mapa nenhum. Aqui o ponto de partida é
 * sempre visível — Início, Estatísticas, Histórico, Contas, Configurações e
 * Perfil — com o item ativo marcado e a marca do app no topo.
 *
 * Design: a largura é uma preferência do usuário, não do tamanho da janela.
 * Recolhido (padrão) o rail mostra só ícones e devolve o espaço ao
 * terminal; expandido, os rótulos voltam. O botão no rodapé alterna os
 * dois estados, e o rótulo nunca some de verdade: em modo ícone ele vira
 * tooltip próprio (`aria-label`), então a navegação continua legível para
 * leitor de tela.
 */

import { usePointerGlow } from "../hooks/usePointerGlow";
import { useUpdateStore } from "../stores/updateStore";
import { Icon, type IconName } from "./Icon";

/** Destinos que a grade pode abrir. */
export type RailDest =
  | "home"
  | "share"
  | "notes"
  | "stats"
  | "history"
  | "accounts"
  | "settings"
  | "profile";

interface NavRailProps {
  active: RailDest;
  notesOpen?: boolean;
  onSelect: (dest: RailDest) => void;
  /** `true` = expandido, com rótulos. `false` = recolhido, só ícones. */
  expanded: boolean;
  onToggleRail: () => void;
  /**
   * Quantas pessoas estão esperando aprovação para entrar na sala. O pedido
   * pode chegar com a tela de compartilhamento fechada, e sem um sinal aqui
   * o convidado ficaria olhando para "aguardando o anfitrião" enquanto o
   * anfitrião não faz ideia de que alguém bateu à porta.
   */
  shareBadge?: number;
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
    dest: "share",
    icon: "share",
    label: "Compartilhar",
    hint: "Trabalhe junto no mesmo terminal",
    group: "principal",
  },
  {
    dest: "notes",
    icon: "pencil",
    label: "Notas",
    hint: "Bloco de anotações do Vibe Coding",
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

export function NavRail({
  active,
  onSelect,
  expanded,
  onToggleRail,
  notesOpen,
  shareBadge = 0,
}: NavRailProps) {
  const versao = useUpdateStore((s) => s.versaoAtual);
  const glowRef = usePointerGlow<HTMLDivElement>();

  const isAtivo = (dest: RailDest) => active === dest || (dest === "notes" && !!notesOpen);

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
              className={`nav-item ${isAtivo(item.dest) ? "active" : ""}`}
              onClick={() => onSelect(item.dest)}
              aria-label={item.label}
              aria-current={isAtivo(item.dest) ? "page" : undefined}
              title={item.label}
            >
              <Icon name={item.icon} size={18} />
              <span className="nav-item-text">
                <span className="nav-item-label">{item.label}</span>
                <span className="nav-item-hint">{item.hint}</span>
              </span>
              {item.dest === "share" && shareBadge > 0 && (
                <span className="nav-item-badge" aria-label={`${shareBadge} esperando para entrar`}>
                  {shareBadge}
                </span>
              )}
            </button>
          </div>
        ))}
      </div>

      <div className="nav-rail-footer">
        <button
          className="nav-rail-toggle"
          onClick={onToggleRail}
          aria-expanded={expanded}
          title={expanded ? "Recolher o menu (só ícones)" : "Expandir o menu (rótulos)"}
          aria-label={expanded ? "Recolher o menu" : "Expandir o menu"}
        >
          <Icon name={expanded ? "chevron-left" : "chevron-right"} size={14} />
          <span className="nav-rail-toggle-text">
            {expanded ? "Recolher" : "Expandir"}
          </span>
        </button>
        {versao && <span className="nav-rail-version">v{versao}</span>}
      </div>
    </nav>
  );
}
