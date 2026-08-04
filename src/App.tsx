import { useCallback, useEffect, useRef, useState } from "react";

import { TerminalView } from "./components/TerminalView";
import {
  appHomeDir,
  onPtyExit,
  ptyClose,
  ptyList,
  ptyResetViews,
  ptySpawn,
  shellsDetect,
  type SessionInfo,
  type ShellProfile,
} from "./lib/ipc";

/**
 * Etapa 1: casca mínima que prova o caminho completo
 * UI -> IPC -> ConPTY -> shell -> volta.
 * As abas com splits, workspaces e estatísticas entram nas etapas seguintes.
 */
export default function App() {
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [home, setHome] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  // Guarda a reconciliação para rodar uma única vez por vida de página. Sem
  // isso, o StrictMode (mount → unmount → mount em desenvolvimento) dispara
  // duas cadeias assíncronas de reset_views concorrentes; se a segunda
  // aterrissar depois que um painel da primeira já se registrou, ela apaga
  // um painel vivo — reintroduzindo o mesmo problema que reset_views existe
  // para resolver, por outra porta.
  const reconciledRef = useRef(false);

  useEffect(() => {
    void shellsDetect().then(setProfiles).catch((e) => setError(String(e)));
    void appHomeDir().then(setHome).catch(() => {});

    if (reconciledRef.current) return;
    reconciledRef.current = true;

    // O dono das sessões é o backend, não este `useState`. Um F5, o HMR do
    // Vite ou uma recuperação de crash do WebView zerariam a lista aqui
    // enquanto os shells continuam vivos — inalcançáveis, sem aba e sem como
    // fechar. Reconciliar na montagem devolve todos eles.
    void ptyList()
      .then(async (existentes) => {
        if (existentes.length === 0) return;

        // Toda montagem daqui é, por definição, uma vida nova de página: os
        // painéis que existiam antes (se houve recarga) nunca rodam o
        // cleanup do React e ficam presos como "views" fantasma no backend,
        // prendendo cada sessão no menor tamanho que aquele painel morto
        // tinha pedido. Isso precisa terminar ANTES de montar os painéis
        // novos, senão o resize deles chega enquanto o fantasma ainda conta.
        await Promise.allSettled(existentes.map((s) => ptyResetViews(s.id)));

        setSessions(existentes);
        setActiveId((atual) => atual ?? existentes[existentes.length - 1].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const p = onPtyExit((e) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === e.id ? { ...s, alive: false, exitCode: e.exitCode } : s,
        ),
      );
    });
    return () => {
      void p.then((fn) => fn());
    };
  }, []);

  const open = useCallback(
    async (profile: ShellProfile) => {
      try {
        const info = await ptySpawn({
          program: profile.program,
          args: profile.args,
          cwd: home || undefined,
          title: profile.name,
          profileId: profile.id,
        });
        setSessions((prev) => [...prev, info]);
        setActiveId(info.id);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [home],
  );

  const close = useCallback(
    async (id: string) => {
      await ptyClose(id).catch(() => {});
      // Calculado fora do updater: o React pode reexecutar um updater mais de
      // uma vez, e definir outro estado lá dentro seria um efeito colateral.
      const restantes = sessions.filter((s) => s.id !== id);
      setSessions(restantes);
      if (activeId === id) {
        setActiveId(restantes[restantes.length - 1]?.id ?? null);
      }
    },
    [sessions, activeId],
  );

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">JARVIS</span>
        <div className="launchers">
          {profiles.map((p) => (
            <button key={p.id} className="chip" onClick={() => void open(p)}>
              + {p.name}
            </button>
          ))}
        </div>
      </header>

      <nav className="tabs">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`tab ${s.id === activeId ? "active" : ""} ${s.alive ? "" : "dead"}`}
            onClick={() => setActiveId(s.id)}
          >
            <span className="dot" />
            {!s.jobbed && (
              <span
                className="warn"
                title="Não foi possível conter esta sessão num Job Object: processos filhos podem sobreviver ao fechamento da aba."
              >
                ⚠
              </span>
            )}
            <span className="label">{s.title}</span>
            <button
              className="x"
              title="Fechar"
              onClick={(e) => {
                e.stopPropagation();
                void close(s.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </nav>

      <main className="stage">
        {error && <div className="error">{error}</div>}
        {sessions.length === 0 && !error && (
          <div className="empty">
            <h1>JARVIS</h1>
            <p>Abra um terminal para começar.</p>
          </div>
        )}
        {sessions.map((s) => (
          // Todas as sessões ficam montadas: desmontar destruiria o xterm e
          // perderia o estado visual a cada troca de aba.
          <div key={s.id} className="pane" hidden={s.id !== activeId}>
            <TerminalView sessionId={s.id} focused={s.id === activeId} />
          </div>
        ))}
      </main>
    </div>
  );
}
