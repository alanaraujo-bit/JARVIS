/**
 * Trabalho compartilhado — o painel de controle.
 *
 * Duas metades separadas por uma aba, porque são dois papéis distintos e
 * misturá-los deixaria a tela ambígua logo no primeiro segundo: **hospedar**
 * (abrir a sala, escolher o que mostrar, aprovar quem entra) e **entrar**
 * (endereço, código, nome).
 *
 * A tela do convidado *depois* de entrar não é esta: assim que a conexão é
 * aceita, o próprio JARVIS troca a área de trabalho pelo `GuestWorkspace`.
 * Aqui ficam só os controles — o trabalho acontece lá.
 */

import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";
import { useCollabStore } from "../stores/collabStore";
import type { SessionInfo } from "../lib/ipc";
import { collabInviteQr, type HostRoom, type QrCode, type TunnelState } from "../lib/collabIpc";
import { inviteUrl, type SharedTerminal } from "../lib/collabProtocol";
import { writeClipboardText } from "../lib/clipboard";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Sessões vivas nesta máquina, para escolher o que compartilhar. */
  sessions: SessionInfo[];
}

export function CollabScreen({ open, onClose, sessions }: Props) {
  const caixaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) caixaRef.current?.focus();
  }, [open]);

  const view = useCollabStore((s) => s.view);
  const setView = useCollabStore((s) => s.setView);
  const guestPhase = useCollabStore((s) => s.guest.phase);

  if (!open) return null;

  return (
    <div className="stats-backdrop" onMouseDown={onClose}>
      <div
        className="stats collab-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Trabalho compartilhado"
        tabIndex={-1}
        ref={caixaRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="stats-header">
          <span>Trabalho compartilhado</span>
          <button
            className="stats-close"
            onClick={onClose}
            title="Fechar (Esc)"
            aria-label="Fechar trabalho compartilhado"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="collab-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={view === "host"}
            className={`collab-tab ${view === "host" ? "on" : ""}`}
            onClick={() => setView("host")}
          >
            <Icon name="share" size={14} />
            Compartilhar meu computador
          </button>
          <button
            role="tab"
            aria-selected={view === "guest"}
            className={`collab-tab ${view === "guest" ? "on" : ""}`}
            onClick={() => setView("guest")}
          >
            <Icon name="link" size={14} />
            Entrar numa sala
            {guestPhase === "joined" && <span className="collab-dot-on" aria-label="conectado" />}
          </button>
        </div>

        {view === "host" ? <PainelAnfitriao sessions={sessions} /> : <PainelConvidado />}
      </div>
    </div>
  );
}

/* ============================== anfitrião ============================== */

function PainelAnfitriao({ sessions }: { sessions: SessionInfo[] }) {
  const host = useCollabStore((s) => s.host);
  const starting = useCollabStore((s) => s.starting);
  const erro = useCollabStore((s) => s.hostError);
  const start = useCollabStore((s) => s.start);
  const stop = useCollabStore((s) => s.stop);

  const [nomeSala, setNomeSala] = useState("");
  const [meuNome, setMeuNome] = useState("");

  if (!host.active || !host.room) {
    return (
      <div className="stats-section collab-start">
        <p className="collab-intro">
          Abra uma sala para outra pessoa acompanhar — e trabalhar — nos terminais
          que você escolher. O projeto continua só aqui: o que viaja é a tela do
          terminal e as teclas de quem você autorizar.
        </p>

        <div className="collab-fields">
          <label className="collab-field">
            <span>Nome da sala</span>
            <input
              value={nomeSala}
              onChange={(e) => setNomeSala(e.target.value)}
              placeholder="Ex.: Ajuste no backend"
              maxLength={48}
            />
          </label>
          <label className="collab-field">
            <span>Como você aparece</span>
            <input
              value={meuNome}
              onChange={(e) => setMeuNome(e.target.value)}
              placeholder="Seu nome"
              maxLength={32}
            />
          </label>
        </div>

        <div className="collab-actions">
          <button
            className="chip chip-on"
            disabled={starting}
            onClick={() =>
              void start({
                name: nomeSala,
                hostName: meuNome,
                requireApproval: true,
                public: false,
              })
            }
          >
            <Icon name="share" size={14} />
            {starting ? "Abrindo…" : "Abrir sala na rede local"}
          </button>
          <button
            className="chip subtle"
            disabled={starting}
            onClick={() =>
              void start({
                name: nomeSala,
                hostName: meuNome,
                requireApproval: true,
                public: true,
              })
            }
          >
            <Icon name="globe" size={14} />
            Abrir com endereço público
          </button>
        </div>
        <p className="collab-hint">
          A sala nasce vazia: nenhum terminal é exposto até você marcar, um a um,
          quais quer mostrar.
        </p>
        {erro && <p className="collab-error">{erro}</p>}
      </div>
    );
  }

  return (
    <>
      <SalaAberta sessions={sessions} />
      <div className="stats-section collab-encerrar">
        <button className="chip danger" onClick={() => void stop()}>
          <Icon name="stop" size={13} />
          Encerrar a sala
        </button>
        {erro && <span className="collab-error">{erro}</span>}
      </div>
    </>
  );
}

/**
 * O convite em forma de câmera: aponta e entra.
 *
 * O endereço do túnel é sorteado a cada sessão e tem doze caracteres
 * aleatórios no meio — digitá-lo num celular é um exercício de paciência com
 * erro quase garantido, e o código de oito caracteres ainda viria depois. O QR
 * carrega os dois de uma vez, e o app do celular entra sozinho.
 */
function QrConvite({ room }: { room: HostRoom }) {
  const url = inviteUrl(room.publicUrl ?? room.lanUrl, room.code);
  const [qr, setQr] = useState<QrCode | null>(null);

  useEffect(() => {
    if (!url) {
      setQr(null);
      return;
    }
    let vivo = true;
    void collabInviteQr(url)
      .then((q) => vivo && setQr(q))
      .catch(() => vivo && setQr(null));
    return () => {
      vivo = false;
    };
  }, [url]);

  if (!url) {
    return (
      <p className="collab-hint">
        Sem endereço ainda: ligue o endereço público abaixo, ou conecte esta
        máquina a uma rede, para o celular ter onde chegar.
      </p>
    );
  }

  const noAr = room.publicUrl !== null;

  return (
    <div className="collab-qr">
      {qr ? <QrDesenho qr={qr} /> : <div className="collab-qr-vazio" />}
      <div className="collab-qr-texto">
        <strong>Abra no celular</strong>
        <p>
          Aponte a câmera. O aparelho abre o JARVIS pelo navegador, já com o
          código preenchido, e você pode instalar como aplicativo pelo menu
          &ldquo;adicionar à tela de início&rdquo;.
        </p>
        <p className="collab-qr-alcance">
          {noAr
            ? "Endereço público: funciona de qualquer lugar, com este computador ligado."
            : "Rede local: funciona no mesmo Wi-Fi. Para usar fora de casa, ligue o endereço público abaixo."}
        </p>
        <button className="chip subtle" onClick={() => void writeClipboardText(url)}>
          <Icon name="copy" size={13} />
          Copiar o link
        </button>
      </div>
    </div>
  );
}

/**
 * A matriz vira um `<path>` só, e não um `<rect>` por módulo.
 *
 * Um QR deste tamanho tem por volta de mil módulos escuros. Mil elementos no
 * DOM, recriados sempre que a sala muda de estado, custariam mais do que o
 * painel inteiro em volta — e o desenho é exatamente o mesmo.
 */
function QrDesenho({ qr }: { qr: QrCode }) {
  const { size, modules } = qr;
  let d = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y * size + x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  // A margem de 4 módulos não é estética: sem a "zona silenciosa" que a norma
  // exige, muitos leitores simplesmente não reconhecem o código.
  const m = 4;
  return (
    <svg
      className="collab-qr-img"
      viewBox={`${-m} ${-m} ${size + m * 2} ${size + m * 2}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Código QR com o endereço e o código da sala"
    >
      <rect x={-m} y={-m} width={size + m * 2} height={size + m * 2} fill="#ffffff" />
      <path d={d} fill="#0b0f14" />
    </svg>
  );
}

function SalaAberta({ sessions }: { sessions: SessionInfo[] }) {
  const room = useCollabStore((s) => s.host.room!);
  const share = useCollabStore((s) => s.share);
  const unshare = useCollabStore((s) => s.unshare);
  const setApproval = useCollabStore((s) => s.setApproval);
  const decide = useCollabStore((s) => s.decide);
  const kick = useCollabStore((s) => s.kick);
  const tunnelUp = useCollabStore((s) => s.tunnelUp);
  const tunnelDown = useCollabStore((s) => s.tunnelDown);
  const baixarTunel = useCollabStore((s) => s.downloadTunnel);

  const compartilhados = new Map<string, SharedTerminal>(
    room.terminals.map((t) => [t.sessionId, t]),
  );

  return (
    <>
      {/* ---------------------------- convite --------------------------- */}
      <div className="stats-section">
        <h3>Convite</h3>
        <div className="collab-code-row">
          <div className="collab-code" aria-label="Código da sala">
            {room.code}
          </div>
          <button
            className="chip subtle"
            onClick={() => void writeClipboardText(room.code)}
            title="Copiar o código"
          >
            <Icon name="copy" size={13} />
            Código
          </button>
        </div>

        <QrConvite room={room} />

        <Endereco rotulo="Rede local" valor={room.lanUrl} icone="monitor" />
        <Tunel
          estado={room.tunnel}
          url={room.publicUrl}
          onSubir={() => void tunnelUp()}
          onDescer={() => void tunnelDown()}
          onBaixar={() => void baixarTunel()}
        />

        <label className="collab-switch">
          <input
            type="checkbox"
            checked={room.requireApproval}
            onChange={(e) => void setApproval(e.target.checked)}
          />
          <span>
            Aprovar cada pessoa que entrar
            <em>
              Recomendado, e indispensável com endereço público: o código sozinho
              não deveria ser a única coisa entre um desconhecido e um terminal.
            </em>
          </span>
        </label>
      </div>

      {/* -------------------------- na porta ---------------------------- */}
      {room.pending.length > 0 && (
        <div className="stats-section collab-pending">
          <h3>Querendo entrar</h3>
          {room.pending.map((p) => (
            <div key={p.id} className="collab-pending-row">
              <span className="collab-pending-name">{p.name}</span>
              <div className="collab-pending-actions">
                <button className="chip chip-on" onClick={() => void decide(p.id, true)}>
                  <Icon name="check" size={13} />
                  Deixar entrar
                </button>
                <button className="chip subtle" onClick={() => void decide(p.id, false)}>
                  Recusar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* -------------------------- terminais --------------------------- */}
      <div className="stats-section">
        <h3>O que está compartilhado</h3>
        {sessions.length === 0 ? (
          <p className="collab-hint">
            Abra um terminal para poder compartilhá-lo.
          </p>
        ) : (
          <div className="collab-term-list">
            {sessions.map((s) => {
              const atual = compartilhados.get(s.id);
              return (
                <div key={s.id} className={`collab-term ${atual ? "on" : ""}`}>
                  <div className="collab-term-id">
                    <Icon name="terminal" size={14} />
                    <span className="collab-term-title">{s.title}</span>
                    {!s.alive && <span className="collab-term-dead">encerrado</span>}
                  </div>
                  <div className="collab-term-modes">
                    <ModoBotao
                      ativo={atual?.mode === "rw"}
                      icone="pencil"
                      rotulo="Pode digitar"
                      onClick={() => void share(s.id, "rw", s.title)}
                    />
                    <ModoBotao
                      ativo={atual?.mode === "ro"}
                      icone="eye"
                      rotulo="Só ver"
                      onClick={() => void share(s.id, "ro", s.title)}
                    />
                    <ModoBotao
                      ativo={!atual}
                      icone="close"
                      rotulo="Não mostrar"
                      onClick={() => void unshare(s.id)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ------------------------ participantes ------------------------- */}
      <div className="stats-section">
        <h3>Na sala</h3>
        <div className="collab-people">
          {room.participants.map((p) => (
            <div key={p.id} className="collab-person">
              <span
                className={`collab-avatar ${p.online ? "" : "off"}`}
                style={{ background: p.color }}
                aria-hidden="true"
              >
                {p.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="collab-person-name">
                {p.name}
                <em>
                  {p.role === "host" ? "anfitrião" : p.online ? "conectado" : "desconectado"}
                </em>
              </span>
              {p.role === "guest" && (
                <button
                  className="chip subtle collab-kick"
                  onClick={() => void kick(p.id)}
                  title="Remover da sala"
                >
                  Remover
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function ModoBotao({
  ativo,
  icone,
  rotulo,
  onClick,
}: {
  ativo: boolean;
  icone: "pencil" | "eye" | "close";
  rotulo: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`chip ${ativo ? "chip-on" : "subtle"}`}
      aria-pressed={ativo}
      onClick={onClick}
    >
      <Icon name={icone} size={13} />
      {rotulo}
    </button>
  );
}

function Endereco({
  rotulo,
  valor,
  icone,
}: {
  rotulo: string;
  valor: string | null;
  icone: "monitor" | "globe";
}) {
  if (!valor) return null;
  return (
    <div className="collab-address">
      <Icon name={icone} size={14} />
      <span className="collab-address-label">{rotulo}</span>
      <code className="collab-address-value">{valor}</code>
      <button
        className="chip subtle"
        onClick={() => void writeClipboardText(valor)}
        title={`Copiar o endereço da ${rotulo.toLowerCase()}`}
      >
        <Icon name="copy" size={13} />
      </button>
    </div>
  );
}

function Tunel({
  estado,
  url,
  onSubir,
  onDescer,
  onBaixar,
}: {
  estado: TunnelState;
  url: string | null;
  onSubir: () => void;
  onDescer: () => void;
  onBaixar: () => void;
}) {
  switch (estado.status) {
    case "up":
      return (
        <>
          <Endereco rotulo="Internet" valor={url} icone="globe" />
          <div className="collab-tunnel-row">
            <button className="chip subtle" onClick={onDescer}>
              Desligar o endereço público
            </button>
          </div>
        </>
      );
    case "starting":
      return <p className="collab-hint">Publicando o endereço na internet…</p>;
    case "downloading":
      return (
        <div className="collab-tunnel-row">
          <div className="collab-progress" aria-label="Baixando o cloudflared">
            <div className="collab-progress-bar" style={{ width: `${estado.percent}%` }} />
          </div>
          <span className="collab-hint">Baixando o cloudflared… {estado.percent}%</span>
        </div>
      );
    case "missing":
      return (
        <div className="collab-tunnel-row">
          <p className="collab-hint">
            Para alguém fora da sua rede entrar, o JARVIS usa o <code>cloudflared</code>,
            da Cloudflare, que abre um endereço público apontando para esta máquina.
            Ele não vem junto com o app — são dezenas de megabytes, e a maioria das
            sessões acontece na mesma casa.
          </p>
          <button className="chip" onClick={onBaixar}>
            <Icon name="globe" size={13} />
            Baixar e habilitar
          </button>
        </div>
      );
    case "error":
      return (
        <div className="collab-tunnel-row">
          <p className="collab-error">{estado.message}</p>
          <button className="chip subtle" onClick={onSubir}>
            Tentar de novo
          </button>
        </div>
      );
    default:
      return (
        <div className="collab-tunnel-row">
          <button className="chip subtle" onClick={onSubir}>
            <Icon name="globe" size={13} />
            Gerar endereço público
          </button>
        </div>
      );
  }
}

/* ============================== convidado ============================== */

function PainelConvidado() {
  const guest = useCollabStore((s) => s.guest);
  const nome = useCollabStore((s) => s.guestName);
  const endereco = useCollabStore((s) => s.guestAddress);
  const codigo = useCollabStore((s) => s.guestCode);
  const setField = useCollabStore((s) => s.setGuestField);
  const join = useCollabStore((s) => s.join);
  const leave = useCollabStore((s) => s.leave);

  const podeEntrar = endereco.trim().length > 0 && codigo.trim().length >= 8;

  if (guest.phase === "joined") {
    return (
      <div className="stats-section collab-start">
        <p className="collab-intro">
          Você está em <strong>{guest.room?.name}</strong>, de {guest.room?.hostName}.
          Os terminais compartilhados estão na área de trabalho, atrás desta janela.
        </p>
        <div className="collab-actions">
          <button className="chip danger" onClick={leave}>
            Sair da sala
          </button>
        </div>
      </div>
    );
  }

  if (guest.phase === "pending") {
    return (
      <div className="stats-section collab-start">
        <p className="collab-intro">
          Pedido enviado para <strong>{guest.room?.hostName}</strong>. Assim que
          ele autorizar, a sala abre sozinha aqui.
        </p>
        <div className="collab-actions">
          <button className="chip subtle" onClick={leave}>
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stats-section collab-start">
      <p className="collab-intro">
        Cole o endereço e o código que o anfitrião passou. Você vai ver os
        terminais dele ao vivo e — se ele permitir — poder digitar neles.
      </p>

      <div className="collab-fields">
        <label className="collab-field wide">
          <span>Endereço da sala</span>
          <input
            value={endereco}
            onChange={(e) => setField({ address: e.target.value })}
            placeholder="ws://192.168.0.10:7391  ou  https://algo.trycloudflare.com"
            spellCheck={false}
          />
        </label>
        <label className="collab-field">
          <span>Código</span>
          <input
            value={codigo}
            onChange={(e) => setField({ code: e.target.value.toUpperCase() })}
            placeholder="AB2C-3D4E"
            spellCheck={false}
            maxLength={12}
            onKeyDown={(e) => {
              if (e.key === "Enter" && podeEntrar) join();
            }}
          />
        </label>
        <label className="collab-field">
          <span>Seu nome</span>
          <input
            value={nome}
            onChange={(e) => setField({ name: e.target.value })}
            placeholder="Como você aparece na sala"
            maxLength={32}
          />
        </label>
      </div>

      <div className="collab-actions">
        <button className="chip chip-on" disabled={!podeEntrar} onClick={join}>
          <Icon name="link" size={14} />
          {guest.phase === "connecting" || guest.phase === "reconnecting"
            ? "Conectando…"
            : "Entrar"}
        </button>
        {(guest.phase === "connecting" || guest.phase === "reconnecting") && (
          <button className="chip subtle" onClick={leave}>
            Cancelar
          </button>
        )}
      </div>

      {guest.message && (
        <p className={guest.phase === "denied" ? "collab-error" : "collab-hint"}>
          {guest.message}
        </p>
      )}
    </div>
  );
}
