/**
 * A área de trabalho do convidado.
 *
 * Substitui as abas locais enquanto ele está numa sala. A escolha de trocar a
 * área inteira, em vez de abrir mais um painel lateral, é o que sustenta a
 * ideia toda: o convidado não está "vendo uma janelinha do computador do
 * outro", ele está trabalhando naquele computador — com o terminal ocupando o
 * lugar de sempre, o mesmo atalho de busca, a mesma renderização.
 *
 * **Nenhum terminal é desmontado ao trocar de aba.** Todos ficam montados e
 * escondidos por `hidden`, exatamente como o app já faz com as abas locais:
 * desmontar destruiria o xterm e o `npm run dev` que roda na aba de trás
 * perderia todo o scrollback quando o convidado voltasse a ela.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { TerminalView } from "./TerminalView";
import { Icon } from "./Icon";
import { useCollabStore } from "../stores/collabStore";
import { remoteTransport } from "../lib/termTransport";
import type { SharedTerminal } from "../lib/collabProtocol";

export function GuestWorkspace() {
  const guest = useCollabStore((s) => s.guest);
  const leave = useCollabStore((s) => s.leave);
  const [ativo, setAtivo] = useState<string | null>(null);
  const [lateral, setLateral] = useState<"chat" | "ia">("chat");

  const terminais = guest.terminals;

  // Segue o que existe: se o terminal aberto sair do ar (o anfitrião parou de
  // compartilhar), a tela cai no primeiro disponível em vez de ficar em
  // branco sem explicação.
  useEffect(() => {
    if (terminais.length === 0) {
      if (ativo !== null) setAtivo(null);
      return;
    }
    if (!ativo || !terminais.some((t) => t.sessionId === ativo)) {
      setAtivo(terminais[0].sessionId);
    }
  }, [terminais, ativo]);

  return (
    <div className="guest">
      <GuestBar guest={guest} onLeave={leave} />

      <div className="guest-body">
        <div className="guest-main">
          {terminais.length > 1 && (
            <div className="guest-tabs" role="tablist">
              {terminais.map((t) => (
                <button
                  key={t.sessionId}
                  role="tab"
                  aria-selected={t.sessionId === ativo}
                  className={`guest-tab ${t.sessionId === ativo ? "on" : ""}`}
                  onClick={() => setAtivo(t.sessionId)}
                >
                  <Icon name={t.mode === "ro" ? "eye" : "terminal"} size={13} />
                  <span className="guest-tab-title">{t.title}</span>
                  {!t.alive && <span className="guest-tab-dead" title="processo encerrado" />}
                </button>
              ))}
            </div>
          )}

          <div className="guest-stage">
            {terminais.length === 0 ? (
              <div className="guest-empty">
                <Icon name="share" size={28} />
                <h2>Ainda não há nada compartilhado</h2>
                <p>
                  {guest.room?.hostName ?? "O anfitrião"} ainda não escolheu quais
                  terminais mostrar. Assim que escolher, eles aparecem aqui sozinhos.
                </p>
              </div>
            ) : (
              terminais.map((t) => (
                <GuestPane key={t.sessionId} terminal={t} visivel={t.sessionId === ativo} />
              ))
            )}
          </div>
        </div>

        <aside className="guest-side">
          <div className="guest-side-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={lateral === "chat"}
              className={`guest-side-tab ${lateral === "chat" ? "on" : ""}`}
              onClick={() => setLateral("chat")}
            >
              <Icon name="users" size={14} />
              Conversa
            </button>
            <button
              role="tab"
              aria-selected={lateral === "ia"}
              className={`guest-side-tab ${lateral === "ia" ? "on" : ""}`}
              onClick={() => setLateral("ia")}
            >
              <Icon name="spark" size={14} />
              JARVIS AI
            </button>
          </div>
          {lateral === "chat" ? <GuestChat /> : <GuestAi />}
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------- barra --------------------------------- */

function GuestBar({
  guest,
  onLeave,
}: {
  guest: ReturnType<typeof useCollabStore.getState>["guest"];
  onLeave: () => void;
}) {
  const reconectando = guest.phase === "reconnecting";
  return (
    <div className={`guest-bar ${reconectando ? "warn" : ""}`}>
      <span className="guest-bar-room">
        <Icon name="share" size={15} />
        <strong>{guest.room?.name}</strong>
        <em>de {guest.room?.hostName}</em>
      </span>

      <div className="guest-bar-people">
        {guest.participants.map((p) => (
          <span
            key={p.id}
            className={`collab-avatar small ${p.online ? "" : "off"}`}
            style={{ background: p.color }}
            title={`${p.name}${p.role === "host" ? " (anfitrião)" : ""}`}
          >
            {p.name.slice(0, 1).toUpperCase()}
          </span>
        ))}
      </div>

      <span className="guest-bar-net">
        {reconectando ? (
          "Reconectando…"
        ) : guest.latency === null ? (
          "medindo…"
        ) : (
          <>
            <span className={`guest-ping ${guest.latency < 60 ? "good" : guest.latency < 200 ? "ok" : "slow"}`} />
            {guest.latency} ms
          </>
        )}
      </span>

      <button className="chip subtle" onClick={onLeave}>
        Sair da sala
      </button>
    </div>
  );
}

/* ------------------------------- terminal ------------------------------- */

function GuestPane({ terminal, visivel }: { terminal: SharedTerminal; visivel: boolean }) {
  const transporte = useMemo(() => remoteTransport(terminal.sessionId), [terminal.sessionId]);
  const somenteLeitura = terminal.mode === "ro";

  return (
    <div className="guest-pane" hidden={!visivel}>
      {somenteLeitura && (
        <div className="guest-ro" title="O anfitrião liberou este terminal só para acompanhar">
          <Icon name="eye" size={13} />
          Só acompanhando
        </div>
      )}
      {!terminal.alive && (
        <div className="guest-dead">
          <Icon name="warning" size={13} />
          O processo deste terminal foi encerrado no computador do anfitrião.
        </div>
      )}
      <TerminalView
        sessionId={terminal.sessionId}
        transport={transporte}
        readOnly={somenteLeitura}
        focused={visivel}
      />
    </div>
  );
}

/* --------------------------------- chat --------------------------------- */

function GuestChat() {
  const chat = useCollabStore((s) => s.guest.chat);
  const eu = useCollabStore((s) => s.guest.me);
  const say = useCollabStore((s) => s.sayAsGuest);
  const [texto, setTexto] = useState("");
  const fimRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fimRef.current?.scrollIntoView({ block: "end" });
  }, [chat.length]);

  const envia = () => {
    if (!texto.trim()) return;
    say(texto);
    setTexto("");
  };

  return (
    <div className="guest-chat">
      <div className="guest-chat-log">
        {chat.length === 0 && (
          <p className="collab-hint">Fale com quem está na sala — o anfitrião vê aqui do lado.</p>
        )}
        {chat.map((m) => (
          <div key={m.id} className={`guest-msg ${m.authorId === eu?.id ? "mine" : ""}`}>
            <span className="guest-msg-who" style={{ color: m.authorColor }}>
              {m.authorName}
            </span>
            <span className="guest-msg-text">{m.text}</span>
          </div>
        ))}
        <div ref={fimRef} />
      </div>
      <div className="guest-chat-input">
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") envia();
          }}
          placeholder="Escreva uma mensagem…"
          maxLength={2000}
        />
        <button className="chip" onClick={envia} aria-label="Enviar">
          <Icon name="send" size={14} />
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------- IA ---------------------------------- */

function GuestAi() {
  const mensagens = useCollabStore((s) => s.sharedAi);
  const ask = useCollabStore((s) => s.askAiAsGuest);
  const hostName = useCollabStore((s) => s.guest.room?.hostName);
  const [texto, setTexto] = useState("");
  const fimRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fimRef.current?.scrollIntoView({ block: "end" });
  }, [mensagens.length]);

  const envia = () => {
    if (!texto.trim()) return;
    ask(texto);
    setTexto("");
  };

  return (
    <div className="guest-chat">
      <div className="guest-chat-log">
        {mensagens.length === 0 && (
          <p className="collab-hint">
            Pergunte à IA do {hostName ?? "anfitrião"}. Ela responde com o contexto do
            terminal ativo lá, e a conversa aparece para todo mundo na sala.
          </p>
        )}
        {mensagens.map((m) => (
          <div key={m.requestId} className="guest-ai-turn">
            <div className="guest-msg">
              <span className="guest-msg-who" style={{ color: m.authorColor }}>
                {m.authorName}
              </span>
              <span className="guest-msg-text">{m.question}</span>
            </div>
            <div className="guest-msg ai">
              <span className="guest-msg-who">
                <Icon name="spark" size={12} /> JARVIS
              </span>
              <span className="guest-msg-text">
                {m.error ? (
                  <em className="collab-error">{m.error}</em>
                ) : (
                  m.answer || (m.streaming ? "Pensando…" : "—")
                )}
              </span>
            </div>
          </div>
        ))}
        <div ref={fimRef} />
      </div>
      <div className="guest-chat-input">
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") envia();
          }}
          placeholder="Perguntar à IA…"
          maxLength={4000}
        />
        <button className="chip" onClick={envia} aria-label="Perguntar">
          <Icon name="send" size={14} />
        </button>
      </div>
    </div>
  );
}
