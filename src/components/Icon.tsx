/**
 * Conjunto de ícones do JARVIS.
 *
 * Por que um arquivo de SVG em vez dos emojis que estavam no lugar: emoji é
 * uma fonte de terceiros que o sistema desenha do jeito dele — colorido,
 * com peso e alinhamento próprios, imune a `currentColor`. Numa interface
 * que precisa de dois temas e de um traço coerente, isso significa um
 * botão que não escurece no tema claro e um ☰ que flutua fora da linha de
 * base ao lado de um ⌘. Traço vetorial resolve os três problemas de uma vez:
 * herda a cor, alinha na grade e tem o mesmo peso em toda a interface.
 *
 * Todos os desenhos vivem numa grade de 24 e usam traço de 1.75 — fino o
 * bastante para não competir com o texto, grosso o bastante para não sumir
 * no tema claro.
 */

export type IconName =
  | "sidebar"
  | "split-right"
  | "split-down"
  | "command"
  | "activity"
  | "spark"
  | "folder"
  | "folder-open"
  | "trash"
  | "settings"
  | "agent"
  | "user"
  | "close"
  | "plus"
  | "search"
  | "chevron-down"
  | "chevron-up"
  | "chevron-right"
  | "check"
  | "sun"
  | "moon"
  | "monitor"
  | "terminal"
  | "play"
  | "stop"
  | "copy"
  | "refresh"
  | "warning"
  | "clock"
  | "zap"
  | "layers"
  | "send"
  | "gauge"
  | "cpu"
  | "coins"
  | "pencil"
  | "history"
  | "pwsh"
  | "cmd"
  | "bash"
  | "linux";

interface IconProps {
  name: IconName;
  /** Tamanho em px. O padrão acompanha a altura da linha de texto da UI. */
  size?: number;
  className?: string;
  /**
   * Ícone puramente decorativo (ao lado de um rótulo que já diz tudo) é
   * escondido do leitor de tela. Passar `title` o torna anunciável — use
   * só quando o ícone for o único conteúdo do controle e não houver
   * `aria-label` no botão que o envolve.
   */
  title?: string;
}

/** `d` dos traços de cada ícone; `fill` fica por conta do `<path>` raro. */
const paths: Record<IconName, React.ReactNode> = {
  sidebar: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  "split-right": (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M12 4.5v15" />
    </>
  ),
  "split-down": (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M3 12h18" />
    </>
  ),
  command: <path d="M15 6a3 3 0 1 1 3 3h-3V6ZM9 6a3 3 0 1 0-3 3h3V6Zm0 12a3 3 0 1 1-3-3h3v3Zm6 0a3 3 0 1 0 3-3h-3v3ZM9 9h6v6H9V9Z" />,
  activity: <path d="M3 12h3.5l2.5-7 4 14 2.5-7H21" />,
  spark: (
    <path d="M12 3.5c.35 3.1 1.4 4.65 3.4 5.6-2 .95-3.05 2.5-3.4 5.6-.35-3.1-1.4-4.65-3.4-5.6 2-.95 3.05-2.5 3.4-5.6ZM18.5 14c.2 1.7.75 2.5 1.85 3.05-1.1.55-1.65 1.35-1.85 3.05-.2-1.7-.75-2.5-1.85-3.05 1.1-.55 1.65-1.35 1.85-3.05ZM6 15c.16 1.35.6 2 1.5 2.45-.9.45-1.34 1.1-1.5 2.45-.16-1.35-.6-2-1.5-2.45.9-.45 1.34-1.1 1.5-2.45Z" />
  ),
  folder: <path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.5.7l1 1.2H19a2 2 0 0 1 2 2v7.1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11Z" />,
  "folder-open": (
    <>
      <path d="M3 8A2 2 0 0 1 5 6h3.4a2 2 0 0 1 1.5.7l1 1.2H18a2 2 0 0 1 2 2v.6" />
      <path d="M3.4 18.5 5.8 12a1.6 1.6 0 0 1 1.5-1.1h13a1 1 0 0 1 .96 1.3l-1.9 5.8a1.6 1.6 0 0 1-1.5 1.1H5a1.6 1.6 0 0 1-1.6-1.6Z" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
      <path d="M6.5 7l.8 11.1a1.6 1.6 0 0 0 1.6 1.4h6.2a1.6 1.6 0 0 0 1.6-1.4L17.5 7" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="2.9" />
      <path d="M12 3.2v2.1M12 18.7v2.1M20.8 12h-2.1M5.3 12H3.2M18.2 5.8l-1.5 1.5M7.3 16.7l-1.5 1.5M18.2 18.2l-1.5-1.5M7.3 7.3 5.8 5.8" />
    </>
  ),
  agent: (
    <>
      <rect x="4" y="7.5" width="16" height="12" rx="3" />
      <path d="M12 4v3.5" />
      <circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </>
  ),
  close: <path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8" />,
  plus: <path d="M12 5.2v13.6M5.2 12h13.6" />,
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.4 15.4 20 20" />
    </>
  ),
  "chevron-down": <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  "chevron-up": <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />,
  "chevron-right": <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
  check: <path d="m5 12.6 4.6 4.6L19 6.8" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3 5.6 5.6" />
    </>
  ),
  moon: <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2Z" />,
  monitor: (
    <>
      <rect x="3" y="4.6" width="18" height="12.4" rx="2.2" />
      <path d="M8.6 20.4h6.8M12 17v3.4" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="m7.6 9.4 2.7 2.6-2.7 2.6M13 15h3.6" />
    </>
  ),
  play: <path d="M8.4 6.2 17.6 12l-9.2 5.8V6.2Z" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.2" />
      <path d="M15 6.6V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20.3 4.4v4.2h-4.2" />
    </>
  ),
  warning: (
    <>
      <path d="M10.6 4.5 3.3 17.2a1.6 1.6 0 0 0 1.4 2.4h14.6a1.6 1.6 0 0 0 1.4-2.4L13.4 4.5a1.6 1.6 0 0 0-2.8 0Z" />
      <path d="M12 9.6v4.2M12 16.9v.1" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.3" />
      <path d="M12 7.4V12l3 1.8" />
    </>
  ),
  zap: <path d="M13.4 2.8 5 13.4h5.6L10 21.2 18.6 10.6H13l.4-7.8Z" />,
  layers: (
    <>
      <path d="m12 3.4 8.4 4.3-8.4 4.3-8.4-4.3 8.4-4.3Z" />
      <path d="m4.2 12.2 7.8 4 7.8-4M4.2 16.6l7.8 4 7.8-4" />
    </>
  ),
  send: <path d="M12 19.5V5m0 0-5.6 5.6M12 5l5.6 5.6" />,
  gauge: (
    <>
      <path d="M4 17.5a8.6 8.6 0 1 1 16 0" />
      <path d="m12 13.5 4-4" />
      <circle cx="12" cy="14.4" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  cpu: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.2" />
      <rect x="10" y="10" width="4" height="4" rx="1" />
      <path d="M9.6 3.4v3.1M14.4 3.4v3.1M9.6 17.5v3.1M14.4 17.5v3.1M3.4 9.6h3.1M3.4 14.4h3.1M17.5 9.6h3.1M17.5 14.4h3.1" />
    </>
  ),
  coins: (
    <>
      <ellipse cx="12" cy="6.8" rx="7" ry="2.9" />
      <path d="M5 6.8v10.4c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9V6.8" />
      <path d="M5 12c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9" />
    </>
  ),
  pencil: (
    <>
      <path d="M16.4 4.6a2 2 0 0 1 2.9 2.8L8.5 18.2l-3.9 1.1 1.1-3.9L16.4 4.6Z" />
    </>
  ),
  history: (
    <>
      <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" />
      <path d="M3.4 4.2v4.2h4.2" />
      <path d="M12 7.8V12l3 1.8" />
    </>
  ),

  /* --------------------------- perfis de shell -------------------------- */
  /* Marcas de shell desenhadas, não logotipos: um chevron para PowerShell,
     um cursor para o Prompt, um cifrão para o Bash, um bloco para o WSL. */
  pwsh: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="m7.8 9 3.2 3-3.2 3M13 15.2h3.4" />
    </>
  ),
  cmd: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M7.4 9.6h3M7.4 14.4h9" />
    </>
  ),
  bash: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M12 7.6v8.8M14.4 9.6c-.5-.7-1.4-1.1-2.6-1.1-1.6 0-2.6.7-2.6 1.8 0 2.5 5.2 1 5.2 3.6 0 1.1-1.1 1.8-2.6 1.8-1.3 0-2.2-.4-2.7-1.2" />
    </>
  ),
  linux: (
    <>
      <path d="M9.4 4.8c0-1 1.2-1.8 2.6-1.8s2.6.8 2.6 1.8v3.4c0 1.6 3.2 4.2 3.2 7.4 0 2.6-2.6 4.4-5.8 4.4s-5.8-1.8-5.8-4.4c0-3.2 3.2-5.8 3.2-7.4V4.8Z" />
      <circle cx="10.6" cy="7.4" r=".9" fill="currentColor" stroke="none" />
      <circle cx="13.4" cy="7.4" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Icon({ name, size = 16, className, title }: IconProps) {
  const node = paths[name];
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Sem isto o ícone encolheria dentro de um flex apertado e viraria uma
      // elipse — acontece em toda linha de lista com texto longo ao lado.
      style={{ flexShrink: 0 }}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {node}
    </svg>
  );
}

/** Mapeia o `icon` que o backend devolve por perfil de shell. */
export function shellIcon(icon: string): IconName {
  switch (icon) {
    case "pwsh":
      return "pwsh";
    case "cmd":
      return "cmd";
    case "bash":
      return "bash";
    case "linux":
      return "linux";
    default:
      return "terminal";
  }
}
