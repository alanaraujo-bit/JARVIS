/**
 * O app inteiro do celular: entrar na sala e conversar com o terminal.
 *
 * A tela de entrada é curta de propósito — nome e código, e nem sempre os
 * dois. O endereço nunca é pedido porque a página **veio** do computador que
 * ela vai controlar (`location.origin`), e o código chega no fragmento da URL
 * quando a entrada foi por QR (`#c=ABCD-EFGH`). No caminho feliz, apontar a
 * câmera para a tela do PC é a interação inteira.
 *
 * O fragmento é o lugar certo para o código por um motivo concreto: o
 * navegador não o envia ao servidor. Ele não entra em log de acesso, de proxy
 * nem do túnel da Cloudflare — diferente de uma query string, que entraria em
 * todos os três.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Terminal } from "@xterm/xterm";

import { collabClient } from "../src/lib/collabClient";
import { normalizeCode, type SharedTerminal } from "../src/lib/collabProtocol";
import { BarraTeclas } from "./BarraTeclas";
import { TerminalRemoto } from "./TerminalRemoto";
import { useAcordar, useAlturaVisivel } from "./useTela";

const codificador = new TextEncoder();

const GUARDADO = {
  nome: "jarvis.movel.nome",
  codigo: "jarvis.movel.codigo",
  fonte: "jarvis.movel.fonte",
  ajustado: "jarvis.movel.ajustado",
} as const;

function ler(chave: string): string | null {
  try {
    return localStorage.getItem(chave);
  } catch {
    return null;
  }
}

function guardar(chave: string, valor: string) {
  try {
    localStorage.setItem(chave, valor);
  } catch {
    /* modo privado do navegador: o app funciona, só não lembra. */
  }
}

/** `#c=ABCD-EFGH` — o código que o QR carrega. */
function codigoDaUrl(): string {
  const bruto = new URLSearchParams(location.hash.slice(1)).get("c");
  return bruto ? normalizeCode(bruto) : "";
}

export function App() {
  useAlturaVisivel();
  useAcordar();

  const estado = useSyncExternalStore(
    (cb) => collabClient.subscribe(cb),
    () => collabClient.snapshotState(),
  );

  // Uma sala aberta com o QR entra sozinha: quem escaneou já disse tudo o que
  // precisava dizer. Pedir "confirme seu nome" em seguida seria uma tela a
  // mais entre a pessoa e o terminal dela.
  const jaTentou = useRef(false);
  useEffect(() => {
    if (jaTentou.current) return;
    const codigo = codigoDaUrl() || ler(GUARDADO.codigo) || "";
    const nome = ler(GUARDADO.nome) || "";
    if (codigo && nome) {
      jaTentou.current = true;
      collabClient.connect({ address: location.origin, code: codigo, name: nome });
    }
  }, []);

  const dentro = estado.phase === "joined" || estado.phase === "reconnecting";
  if (!dentro && estado.terminals.length === 0) {
    return <Entrada estado={estado} aoEntrar={() => (jaTentou.current = true)} />;
  }
  return <Sala estado={estado} />;
}

/* ------------------------------- entrada --------------------------------- */

type Estado = ReturnType<typeof collabClient.snapshotState>;

function Entrada({ estado, aoEntrar }: { estado: Estado; aoEntrar: () => void }) {
  const [nome, setNome] = useState(() => ler(GUARDADO.nome) || "");
  const [codigo, setCodigo] = useState(() => codigoDaUrl() || ler(GUARDADO.codigo) || "");

  const conectando = estado.phase === "connecting" || estado.phase === "pending";
  const podeEntrar = nome.trim().length > 0 && normalizeCode(codigo).length === 9;

  const entrar = () => {
    if (!podeEntrar) return;
    const limpo = normalizeCode(codigo);
    guardar(GUARDADO.nome, nome.trim());
    guardar(GUARDADO.codigo, limpo);
    aoEntrar();
    collabClient.connect({ address: location.origin, code: limpo, name: nome.trim() });
  };

  return (
    <div className="tela entrada">
      <div className="entrada-caixa">
        <h1>JARVIS</h1>
        <p className="sub">O terminal do seu computador, aqui.</p>

        <label>
          Seu nome
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="como você aparece na sala"
            autoComplete="nickname"
            enterKeyHint="next"
          />
        </label>

        <label>
          Código da sala
          <input
            value={codigo}
            onChange={(e) => setCodigo(normalizeCode(e.target.value))}
            placeholder="ABCD-EFGH"
            // Um código em maiúsculas num campo que corrige a primeira letra e
            // sugere palavra seria uma briga por caractere.
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="go"
            onKeyDown={(e) => e.key === "Enter" && entrar()}
          />
        </label>

        <button className="principal" disabled={!podeEntrar || conectando} onClick={entrar}>
          {estado.phase === "pending" ? "Esperando o anfitrião…" : conectando ? "Entrando…" : "Entrar"}
        </button>

        {estado.phase === "pending" && (
          <p className="aviso">
            Pedido enviado. Aceite no computador para o terminal aparecer aqui.
          </p>
        )}
        {estado.message && estado.phase !== "pending" && (
          <p className="erro">{estado.message}</p>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- sala ---------------------------------- */

function Sala({ estado }: { estado: Estado }) {
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const [ajustes, setAjustes] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [fonte, setFonte] = useState(() => Number(ler(GUARDADO.fonte)) || 13);
  const [ajustado, setAjustado] = useState(() => ler(GUARDADO.ajustado) !== "nao");

  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;
  const termRef = useRef<Terminal | null>(null);

  // Sem escolha explícita, o primeiro terminal em que dá para digitar. É o que
  // a pessoa quer em 99% das vezes: os de só leitura estão na sala para
  // acompanhar, não para trabalhar.
  const atual: SharedTerminal | undefined = useMemo(() => {
    const achado = estado.terminals.find((t) => t.sessionId === escolhido);
    if (achado) return achado;
    return estado.terminals.find((t) => t.mode === "rw") ?? estado.terminals[0];
  }, [estado.terminals, escolhido]);

  useEffect(() => guardar(GUARDADO.fonte, String(fonte)), [fonte]);
  useEffect(() => guardar(GUARDADO.ajustado, ajustado ? "sim" : "nao"), [ajustado]);

  const mandarTecla = (seq: string) => {
    if (!atual || atual.mode !== "rw") return;
    collabClient.sendInput(atual.sessionId, codificador.encode(seq));
    setCtrl(false);
    termRef.current?.focus();
  };

  if (!atual) {
    return (
      <div className="tela vazia">
        <p>Você está na sala, mas nenhum terminal foi compartilhado ainda.</p>
        <p className="sub">Marque um no computador para ele aparecer aqui.</p>
        <Estado estado={estado} />
      </div>
    );
  }

  return (
    <div className="tela sala">
      <header className="topo">
        <button
          className="topo-titulo"
          onClick={() => setAjustes((v) => !v)}
          aria-expanded={ajustes}
        >
          <span className="nome">{atual.title}</span>
          {atual.folder && <span className="pasta">{atual.folder}</span>}
        </button>
        <Estado estado={estado} />
      </header>

      {estado.terminals.length > 1 && (
        <div className="abas">
          {estado.terminals.map((t) => (
            <button
              key={t.sessionId}
              className={`aba ${t.sessionId === atual.sessionId ? "ativa" : ""}`}
              onClick={() => setEscolhido(t.sessionId)}
            >
              {t.title}
              {t.mode === "ro" && <span className="so-leitura">olhando</span>}
            </button>
          ))}
        </div>
      )}

      {ajustes && (
        <Ajustes
          fonte={fonte}
          setFonte={setFonte}
          ajustado={ajustado}
          setAjustado={setAjustado}
          estado={estado}
          onFechar={() => setAjustes(false)}
        />
      )}

      <TerminalRemoto
        info={atual}
        ajustado={ajustado}
        fonte={fonte}
        ctrlArmado={ctrlRef}
        onCtrlConsumido={() => setCtrl(false)}
        onPronto={(t) => (termRef.current = t)}
      />

      {atual.mode === "ro" ? (
        <div className="so-olhando">
          Você só está acompanhando este terminal. Peça o comando no computador
          para poder digitar.
        </div>
      ) : (
        <BarraTeclas
          onTecla={mandarTecla}
          ctrlArmado={ctrl}
          onCtrl={() => {
            setCtrl((v) => !v);
            termRef.current?.focus();
          }}
          desativada={false}
        />
      )}
    </div>
  );
}

function Estado({ estado }: { estado: Estado }) {
  const ligado = estado.phase === "joined";
  return (
    <div className={`estado ${ligado ? "on" : "off"}`}>
      <span className="ponto" />
      <span>
        {ligado
          ? estado.latency !== null
            ? `${estado.latency} ms`
            : "no ar"
          : estado.phase === "reconnecting"
            ? "voltando…"
            : "sem conexão"}
      </span>
    </div>
  );
}

function Ajustes({
  fonte,
  setFonte,
  ajustado,
  setAjustado,
  estado,
  onFechar,
}: {
  fonte: number;
  setFonte: (n: number) => void;
  ajustado: boolean;
  setAjustado: (v: boolean) => void;
  estado: Estado;
  onFechar: () => void;
}) {
  return (
    <div className="painel">
      <div className="linha">
        <span>Tamanho da letra</span>
        <div className="passos">
          <button onClick={() => setFonte(Math.max(8, fonte - 1))}>A−</button>
          <span className="valor">{fonte}</span>
          <button onClick={() => setFonte(Math.min(24, fonte + 1))}>A+</button>
        </div>
      </div>

      <label className="linha alternador">
        <span>
          Ajustar ao celular
          <em>
            Encolhe o terminal para caber aqui — e ele encolhe também na tela do
            computador, porque o terminal é o mesmo. Desligado, você vê as
            colunas do computador com a letra menor.
          </em>
        </span>
        <input
          type="checkbox"
          checked={ajustado}
          onChange={(e) => setAjustado(e.target.checked)}
        />
      </label>

      <div className="linha gente">
        <span>Na sala</span>
        <div className="pessoas">
          {estado.participants.map((p) => (
            <span key={p.id} className={`pessoa ${p.online ? "" : "fora"}`}>
              <i style={{ background: p.color }} />
              {p.name}
            </span>
          ))}
        </div>
      </div>

      <div className="linha acoes">
        <button className="sair" onClick={() => collabClient.reset()}>
          Sair da sala
        </button>
        <button onClick={onFechar}>Fechar</button>
      </div>
    </div>
  );
}
