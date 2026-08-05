/**
 * Tema do app: claro, escuro e "seguir o sistema".
 *
 * O CSS é o dono das cores da interface (`src/styles/tokens.css`); este
 * módulo existe por causa do xterm, que não lê variáveis CSS — ele quer um
 * objeto com cores resolvidas e precisa ser reconfigurado à mão quando o
 * tema troca. Manter as duas paletas aqui, lado a lado, é o que impede a
 * interface e o terminal de divergirem.
 */

import type { ITheme } from "@xterm/xterm";

export type ThemeMode = "system" | "dark" | "light";
/** O que de fato está pintado na tela: `system` já foi resolvido. */
export type ResolvedTheme = "dark" | "light";

/** Espelho em JS dos tokens de cor de `tokens.css`, para quem não lê CSS. */
export interface Palette {
  bg: string;
  surface1: string;
  surface2: string;
  text: string;
  textMuted: string;
  accent: string;
  ok: string;
  warn: string;
  danger: string;
}

const darkPalette: Palette = {
  bg: "#0b0d11",
  surface1: "#101319",
  surface2: "#161a22",
  text: "#e7ebf3",
  textMuted: "#9aa4b8",
  accent: "#5aa9ff",
  ok: "#4ade80",
  warn: "#fbbf24",
  danger: "#f87171",
};

const lightPalette: Palette = {
  bg: "#f6f7f9",
  surface1: "#ffffff",
  surface2: "#f1f3f6",
  text: "#131720",
  textMuted: "#5b6475",
  accent: "#125bc0",
  ok: "#12703a",
  warn: "#845000",
  danger: "#b31f1f",
};

/**
 * Paleta ANSI escura. Os 16 slots seguem a convenção do terminal, não a da
 * interface: um programa que pinta erro de `red` espera vermelho, e não a
 * cor de perigo do app.
 */
const darkXterm: ITheme = {
  background: darkPalette.bg,
  foreground: darkPalette.text,
  cursor: darkPalette.accent,
  cursorAccent: darkPalette.bg,
  selectionBackground: "rgba(90, 169, 255, 0.3)",
  black: "#1c202b",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#5eead4",
  white: "#dfe4ee",
  brightBlack: "#4b5468",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fcd34d",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#99f6e4",
  brightWhite: "#ffffff",
};

/**
 * Paleta ANSI clara. As cores são escurecidas, não reaproveitadas: o
 * amarelo `#fbbf24` do tema escuro sobre fundo branco fica ilegível — é o
 * caso clássico de saída de build "warning" que some da tela.
 */
const lightXterm: ITheme = {
  background: lightPalette.bg,
  foreground: "#1b2129",
  cursor: lightPalette.accent,
  cursorAccent: lightPalette.bg,
  selectionBackground: "rgba(18, 91, 192, 0.22)",
  black: "#1b2129",
  red: "#b31f1f",
  green: "#12703a",
  yellow: "#845000",
  blue: "#1a44c4",
  magenta: "#8b2fb8",
  cyan: "#0e7490",
  white: "#5b6475",
  brightBlack: "#7b8494",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#b45309",
  brightBlue: "#2563eb",
  brightMagenta: "#a838d6",
  brightCyan: "#0891b2",
  brightWhite: "#131720",
};

export const themes: Record<ResolvedTheme, { palette: Palette; xterm: ITheme }> = {
  dark: { palette: darkPalette, xterm: darkXterm },
  light: { palette: lightPalette, xterm: lightXterm },
};

/** Consulta do sistema operacional, tolerante a ambientes sem `matchMedia`. */
export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? systemTheme() : mode;
}

/** Lê um valor vindo do disco sem confiar nele. Desconhecido vira `system`. */
export function parseThemeMode(raw: unknown): ThemeMode {
  return raw === "dark" || raw === "light" || raw === "system" ? raw : "system";
}

/**
 * Aplica o tema ao documento.
 *
 * Escreve num atributo do `<html>`, e não numa classe do `<body>`: as
 * variáveis vivem em `:root`, e o atributo é o único gancho que já existe
 * antes do React montar — é o que permite ao script de arranque pintar a
 * tela na cor certa e evitar o flash branco.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.colorScheme = resolved;
}

export function applyDensity(density: "compact" | "cozy"): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-density", density);
  remember("jarvis.density", density);
}

/**
 * Espelha a preferência num armazenamento síncrono, para o script de
 * arranque do `index.html` poder pintar o tema antes do primeiro quadro.
 * O config em disco continua sendo a fonte da verdade; isto é só o palpite
 * que evita o flash.
 */
function remember(chave: string, valor: string): void {
  try {
    localStorage.setItem(chave, valor);
  } catch {
    // Armazenamento bloqueado — o app funciona igual, só volta a piscar.
  }
}

export function rememberThemeMode(mode: ThemeMode): void {
  remember("jarvis.theme", mode);
}

/**
 * Avisa quando o tema do sistema muda. Só importa no modo `system` — mas o
 * ouvinte fica sempre ligado e quem chama decide o que fazer, para não
 * haver janela em que a troca acontece com o ouvinte desmontado.
 */
export function watchSystemTheme(cb: (t: ResolvedTheme) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const handler = (e: MediaQueryListEvent) => cb(e.matches ? "light" : "dark");
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

/**
 * Compatibilidade com o código que ainda importa `theme.xterm` / `theme.palette`
 * direto. Reflete o tema em vigor no momento da leitura.
 */
export const theme = {
  get palette(): Palette {
    const t = document?.documentElement?.getAttribute("data-theme");
    return t === "light" ? lightPalette : darkPalette;
  },
  get xterm(): ITheme {
    const t = document?.documentElement?.getAttribute("data-theme");
    return t === "light" ? lightXterm : darkXterm;
  },
};
