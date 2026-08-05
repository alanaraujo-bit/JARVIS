/**
 * Estado da atualização do app, num lugar só.
 *
 * Antes a checagem morava dentro do `UpdateBanner`: quem quisesse um botão
 * "procurar atualizações" em qualquer outro canto teria que disparar uma
 * segunda checagem, com seu próprio estado, e as duas se contradiriam na
 * tela. Com o estado aqui, o aviso flutuante e o painel são duas janelas
 * para o mesmo processo — clicar em "Atualizar" no painel move a barra do
 * aviso, e vice-versa.
 */

import { create } from "zustand";

import { checkForUpdate, currentVersion, relaunchApp, type UpdateInfo } from "../lib/updater";
import {
  INTERVALO_CHECAGEM_MS,
  deveAvisar,
  podeChecarDeNovo,
} from "../lib/updateRules";

export type UpdateFase =
  /** Nada foi consultado ainda nesta execução. */
  | "ocioso"
  | "checando"
  | "disponivel"
  | "baixando"
  /** Instalado no disco; falta reabrir o app. */
  | "pronto"
  /** Checou e não havia versão nova. */
  | "atualizado"
  | "erro"
  /** Fora do app nativo (navegador/dev/e2e). */
  | "indisponivel";

/**
 * A versão recusada no "Agora não" sobrevive ao fechamento do app, senão o
 * mesmo aviso volta na próxima abertura e o botão não significa nada.
 *
 * Mora no `localStorage`, e não no config em disco, por ser preferência
 * puramente visual desta máquina: gravá-la no config exigiria um campo novo
 * no backend em Rust para guardar algo que ninguém precisa ler de lá.
 */
const CHAVE_DISPENSADA = "jarvis.update.dispensada";

function lerDispensada(): string | null {
  try {
    return window.localStorage.getItem(CHAVE_DISPENSADA);
  } catch {
    // `localStorage` pode estar bloqueado; não avisar é pior que avisar duas
    // vezes, então o padrão é mostrar.
    return null;
  }
}

function gravarDispensada(versao: string) {
  try {
    window.localStorage.setItem(CHAVE_DISPENSADA, versao);
  } catch {
    /* preferência opcional: perder não quebra nada */
  }
}

export interface UpdateStore {
  fase: UpdateFase;
  update: UpdateInfo | null;
  erro: string | null;
  /** Versão instalada. `null` até o `init` responder, ou fora do app nativo. */
  versaoAtual: string | null;
  /** `Date.now()` da última consulta concluída — de sucesso ou não. */
  ultimaChecagem: number | null;
  baixado: number;
  total: number | null;
  /** Aviso flutuante na tela. O painel pode estar aberto sem ele. */
  avisoVisivel: boolean;
  painelAberto: boolean;

  /** Lê a versão instalada. Idempotente. */
  init: () => Promise<void>;
  /**
   * Consulta o servidor. `manual` vem de um clique: ignora o intervalo entre
   * checagens e mostra o resultado mesmo quando não há novidade.
   */
  checar: (manual?: boolean) => Promise<void>;
  instalar: () => Promise<void>;
  reiniciar: () => Promise<void>;
  /** "Agora não": esconde o aviso e silencia esta versão para sempre. */
  dispensarAviso: () => void;
  abrirPainel: () => void;
  fecharPainel: () => void;
  /**
   * Liga a checagem periódica e a primeira consulta da execução. Devolve o
   * cancelador, para o `useEffect` que a chamou.
   */
  iniciarChecagemAutomatica: () => () => void;
}

/** Fases em que uma checagem automática só atrapalharia. */
function ocupado(fase: UpdateFase): boolean {
  return fase === "checando" || fase === "baixando" || fase === "pronto";
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  fase: "ocioso",
  update: null,
  erro: null,
  versaoAtual: null,
  ultimaChecagem: null,
  baixado: 0,
  total: null,
  avisoVisivel: false,
  painelAberto: false,

  init: async () => {
    if (get().versaoAtual !== null) return;
    const v = await currentVersion();
    if (v) set({ versaoAtual: v });
  },

  checar: async (manual = false) => {
    const { fase, ultimaChecagem } = get();
    if (ocupado(fase)) return;
    if (!manual && !podeChecarDeNovo(ultimaChecagem, Date.now())) return;

    set({ fase: "checando", erro: null });
    const r = await checkForUpdate();
    const agora = Date.now();

    if (r.status === "disponivel") {
      set({
        fase: "disponivel",
        update: r.update,
        erro: null,
        ultimaChecagem: agora,
        versaoAtual: r.update.currentVersion,
        baixado: 0,
        total: null,
        // Numa checagem manual o aviso flutuante seria redundante: a pessoa
        // está olhando o painel, que já mostra tudo com mais detalhe.
        avisoVisivel: !manual && deveAvisar(r.update.version, lerDispensada()),
      });
      return;
    }

    if (r.status === "atualizado") {
      set({
        fase: "atualizado",
        update: null,
        erro: null,
        ultimaChecagem: agora,
        versaoAtual: r.version || get().versaoAtual,
        avisoVisivel: false,
      });
      return;
    }

    if (r.status === "erro") {
      // Falha de rede não vira aviso na cara de quem só queria abrir um
      // terminal: o erro fica guardado para o painel mostrar a quem for lá
      // procurar. A checagem manual leva o usuário ao painel de qualquer
      // forma, então ele vê a mensagem lá.
      set({ fase: "erro", erro: r.message, ultimaChecagem: agora, avisoVisivel: false });
      return;
    }

    set({ fase: "indisponivel", ultimaChecagem: agora, avisoVisivel: false });
  },

  instalar: async () => {
    const { update } = get();
    if (!update) return;

    set({ fase: "baixando", baixado: 0, total: null, erro: null });
    try {
      await update.install((baixado, total) => set({ baixado, total }));
      set({ fase: "pronto", avisoVisivel: true });
      await relaunchApp();
    } catch (e) {
      set({
        fase: "erro",
        erro: e instanceof Error ? e.message : String(e),
        // Aqui o aviso FICA: diferente da checagem de fundo, este erro é
        // resposta a um clique — sumir em silêncio depois de "Atualizar"
        // pareceria que o app travou.
        avisoVisivel: true,
      });
    }
  },

  reiniciar: async () => {
    await relaunchApp();
  },

  dispensarAviso: () => {
    const v = get().update?.version;
    if (v) gravarDispensada(v);
    set({ avisoVisivel: false });
  },

  abrirPainel: () => {
    set({ painelAberto: true, avisoVisivel: false });
    // Abrir o painel sem nunca ter checado mostraria "ocioso" — que não diz
    // nada. Uma consulta respeitando o intervalo resolve, sem transformar
    // cada abertura numa ida à rede.
    if (get().fase === "ocioso") void get().checar();
  },

  fecharPainel: () => set({ painelAberto: false }),

  iniciarChecagemAutomatica: () => {
    // Um atraso curto tira a checagem do caminho crítico da abertura: o
    // primeiro terminal aparece antes de qualquer coisa tocar a rede.
    const primeira = window.setTimeout(() => void get().checar(), 3000);

    // O JARVIS fica aberto por dias; sem isto, quem nunca fecha o app só
    // descobriria uma versão nova ao reiniciar a máquina.
    const periodica = window.setInterval(() => void get().checar(), INTERVALO_CHECAGEM_MS);

    // Voltar para a janela é o momento natural de reavaliar, e o `checar`
    // respeita o intervalo — alternar de janela o dia todo não gera enxurrada
    // de requisições.
    const aoFocar = () => void get().checar();
    window.addEventListener("focus", aoFocar);

    return () => {
      window.clearTimeout(primeira);
      window.clearInterval(periodica);
      window.removeEventListener("focus", aoFocar);
    };
  },
}));
