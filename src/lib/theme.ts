import type { ITheme } from "@xterm/xterm";

/** Paleta única do app: a UI e o xterm leem daqui, nunca de literais soltos. */
const palette = {
  bg: "#0b0d12",
  bgAlt: "#11141b",
  surface: "#161a23",
  border: "#232936",
  text: "#dfe4ee",
  textDim: "#8b94a7",
  accent: "#5eead4",
  accentDim: "#2dd4bf",
  danger: "#f87171",
  warn: "#fbbf24",
  ok: "#4ade80",
};

const xterm: ITheme = {
  background: palette.bg,
  foreground: palette.text,
  cursor: palette.accent,
  cursorAccent: palette.bg,
  selectionBackground: "#2dd4bf40",
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

export const theme = { palette, xterm };
