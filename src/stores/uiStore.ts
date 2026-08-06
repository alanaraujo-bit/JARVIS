/**
 * Preferências visuais do app: tema e densidade.
 *
 * Fica separado do `workspaceStore` e do `aiStore` porque a persistência do
 * config é feita por fatias — cada store manda só o que é seu, e o merge
 * acontece no backend. Um store de UI que salvasse `ui` inteiro apagaria o
 * `aiPanelOpen` que o painel de IA acabou de gravar.
 */

import { create } from "zustand";

import { configSave } from "../lib/ipc";
import {
  applyDensity,
  applyTheme,
  parseThemeMode,
  rememberThemeMode,
  resolveTheme,
  themes,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "../lib/theme";
import { retintTerminals } from "../lib/terminalRegistry";

export type Density = "compact" | "cozy";

export interface UiStore {
  themeMode: ThemeMode;
  /** O tema efetivamente pintado — `system` já resolvido. */
  resolved: ResolvedTheme;
  density: Density;
  /** Introdução de primeira execução já concluída. */
  onboardingDone: boolean;
  /**
   * Menu lateral expandido (rótulos visíveis) ou recolhido (só ícones).
   * Nasce `false` de propósito: o menu começa minimizado, e quem quiser
   * rótulos expande — o terminal nunca perde espaço sem que a pessoa peça.
   */
  railExpanded: boolean;

  setThemeMode: (mode: ThemeMode) => void;
  /** Marca a introdução como vista (ou a reexibe, passando `false`). */
  setOnboardingDone: (done: boolean) => void;
  cycleTheme: () => void;
  setDensity: (d: Density) => void;
  setRailExpanded: (expanded: boolean) => void;
  /** Aplica o que veio do disco, sem regravar. */
  hydrate: (raw: {
    theme?: unknown;
    density?: unknown;
    onboardingDone?: unknown;
    railExpanded?: unknown;
  }) => void;
  /** Liga o ouvinte do tema do sistema. Devolve o cancelador. */
  startSystemWatch: () => () => void;
}

/** Aplica ao documento e repinta os terminais já montados, na ordem certa. */
function paint(resolved: ResolvedTheme) {
  applyTheme(resolved);
  retintTerminals(themes[resolved].xterm);
}

function parseDensity(raw: unknown): Density {
  return raw === "compact" ? "compact" : "cozy";
}

export const useUiStore = create<UiStore>((set, get) => ({
  themeMode: "system",
  resolved: resolveTheme("system"),
  density: "cozy",
  // Otimista: a introdução só aparece quando o config em disco diz que ela
  // ainda não foi vista. Começar como "vista" evita um flash de onboarding
  // para quem já usou o app, enquanto o config carrega em paralelo.
  onboardingDone: true,
  // Minimizado por padrão, como o resto do estado — o config em disco
  // (carregado no `hydrate`) é quem pode expandir.
  railExpanded: false,

  setThemeMode: (mode) => {
    const resolved = resolveTheme(mode);
    set({ themeMode: mode, resolved });
    paint(resolved);
    rememberThemeMode(mode);
    void configSave({ ui: { theme: mode } }).catch(() => {});
  },

  /**
   * Ordem do ciclo: sistema → claro → escuro. Começa em "sistema" porque é
   * onde o app nasce, e um ciclo que não passasse por ele tornaria o modo
   * automático irrecuperável sem abrir as preferências.
   */
  cycleTheme: () => {
    const ordem: ThemeMode[] = ["system", "light", "dark"];
    const atual = ordem.indexOf(get().themeMode);
    get().setThemeMode(ordem[(atual + 1) % ordem.length]);
  },

  setDensity: (d) => {
    set({ density: d });
    applyDensity(d);
    void configSave({ ui: { density: d } }).catch(() => {});
  },

  setRailExpanded: (expanded) => {
    set({ railExpanded: expanded });
    void configSave({ ui: { railExpanded: expanded } }).catch(() => {});
  },

  hydrate: (raw) => {
    const mode = parseThemeMode(raw.theme);
    const density = parseDensity(raw.density);
    const resolved = resolveTheme(mode);
    set({
      themeMode: mode,
      resolved,
      density,
      onboardingDone: raw.onboardingDone !== false,
      // Só `true` expande: configs antigos, sem o campo, continuam com o
      // menu recolhido — o novo padrão.
      railExpanded: raw.railExpanded === true,
    });
    paint(resolved);
    rememberThemeMode(mode);
    applyDensity(density);
  },

  setOnboardingDone: (done) => {
    set({ onboardingDone: done });
    void configSave({ ui: { onboardingDone: done } }).catch(() => {});
  },

  startSystemWatch: () =>
    watchSystemTheme((doSistema) => {
      // Só obedece o sistema quem escolheu segui-lo. Sem esta guarda, quem
      // fixou "escuro" veria o app clarear ao amanhecer junto com o Windows.
      if (get().themeMode !== "system") return;
      set({ resolved: doSistema });
      paint(doSistema);
    }),
}));
