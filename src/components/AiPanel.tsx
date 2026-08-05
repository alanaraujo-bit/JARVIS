/**
 * Painel lateral de chat com o agente de IA (JARVIS).
 *
 * Abre/fecha com Ctrl+Shift+I. Exibe mensagens em streaming com
 * blocos de código copiáveis e executáveis no terminal ativo.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAiStore } from "../stores/aiStore";
import { AiSettings } from "./AiSettings";
import { Icon } from "./Icon";

interface AiPanelProps {
  /** Callback para executar um comando no terminal ativo. */
  onRunCommand?: (command: string) => void;
  /** Contexto para capturar linhas do terminal. */
  captureContext: () => { systemPrompt: string; context: import("../lib/aiContext").AiContext };
}

export function AiPanel({ onRunCommand, captureContext }: AiPanelProps) {
  const {
    panelOpen,
    settingsOpen,
    messages,
    streaming,
    toggleSettings,
    sendMessage,
    cancelStream,
    clearMessages,
    config,
  } = useAiStore();

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll ao receber novas mensagens
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize do textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + "px";
    }
  }, [input]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    const { systemPrompt, context } = captureContext();
    void sendMessage(text, context, systemPrompt);
  }, [input, streaming, captureContext, sendMessage]);

  const retry = useCallback(
    (pergunta: string) => {
      if (!pergunta || streaming) return;
      const { systemPrompt, context } = captureContext();
      void sendMessage(pergunta, context, systemPrompt);
    },
    [streaming, captureContext, sendMessage],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Sempre montado, pelo mesmo motivo da barra de workspaces: gaveta que
  // desmonta não desliza para fora, pisca. `inert` tira o conteúdo fechado
  // do Tab e do leitor de tela — inclusive o campo de texto, que sem isso
  // roubaria o foco de dentro de um painel invisível.
  return (
    <aside className={`ai-panel ${panelOpen ? "open" : ""}`} inert={!panelOpen}>
      <div className="ai-panel-inner">
      <div className="ai-panel-header">
        <span className="ai-panel-title">
          <span className="ai-icon">
            <Icon name="spark" size={15} />
          </span>{" "}
          JARVIS AI
          {/* Sem isto não havia como saber com quem se está falando sem
              abrir as configurações. */}
          <span className="ai-panel-sub">
            {config.provider} · {config.model}
          </span>
        </span>
        <div className="ai-panel-actions">
          <button
            className="ai-header-btn"
            onClick={clearMessages}
            // Limpar no meio de uma geração deixaria o streaming escrevendo
            // numa mensagem que não existe mais; desabilitar mostra isso em
            // vez de ignorar o clique em silêncio.
            disabled={streaming || messages.length === 0}
            title={
              streaming
                ? "Aguarde a resposta terminar para limpar"
                : "Limpar conversa (Ctrl+Shift+L)"
            }
          >
            <Icon name="trash" size={15} />
          </button>
          <button
            className="ai-header-btn"
            onClick={toggleSettings}
            title="Configurações de IA"
            aria-label="Configurações de IA"
          >
            <Icon name="settings" size={15} />
          </button>
        </div>
      </div>

      {settingsOpen && <AiSettings />}

      <div className="ai-messages">
        {messages.length === 0 && (
          <div className="ai-welcome">
            <div className="ai-welcome-icon">
              <Icon name="spark" size={26} />
            </div>
            <h3>JARVIS AI</h3>
            <p>Assistente integrado ao seu terminal.</p>
            <p className="ai-welcome-hint">
              Faça perguntas, peça comandos, ou descreva o que precisa fazer.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={msg.id} className={`ai-msg ai-msg-${msg.role}`}>
            <div className="ai-msg-avatar">
              <Icon name={msg.role === "user" ? "user" : "spark"} size={14} />
            </div>
            <div className="ai-msg-body">
              <MessageContent content={msg.content} streaming={msg.streaming} onRunCommand={onRunCommand} />

              {msg.cancelled && <div className="ai-msg-note">Interrompido por você.</div>}

              {msg.error && (
                <div className="ai-msg-error">
                  <span className="ai-msg-error-text">{msg.error}</span>
                  <button
                    className="ai-msg-retry"
                    // Reenvia a pergunta que originou esta resposta, para o
                    // usuário não ter que redigitar tudo depois de uma falha
                    // de rede ou de uma chave recém-corrigida.
                    onClick={() => retry(messages[i - 1]?.content ?? "")}
                    disabled={streaming || !messages[i - 1]}
                  >
                    Tentar de novo
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="ai-input-area">
        {streaming && (
          <button className="ai-cancel-btn" onClick={() => void cancelStream()}>
            <Icon name="stop" size={13} />
            Parar geração
          </button>
        )}
        <div className="ai-input-row">
          <textarea
            ref={textareaRef}
            className="ai-input"
            placeholder="Pergunte ao JARVIS..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={streaming}
          />
          <button
            className="ai-send-btn"
            onClick={handleSend}
            disabled={!input.trim() || streaming}
            title="Enviar (Enter)"
            aria-label="Enviar"
          >
            <Icon name="send" size={15} />
          </button>
        </div>
      </div>
      </div>
    </aside>
  );
}

/* -------------- Renderização de conteúdo com blocos de código -------------- */

interface MessageContentProps {
  content: string;
  streaming?: boolean;
  onRunCommand?: (command: string) => void;
}

function MessageContent({ content, streaming, onRunCommand }: MessageContentProps) {
  if (!content && streaming) {
    return <span className="ai-typing">Pensando<span className="ai-dots">...</span></span>;
  }

  // Parse simples de blocos de código ```...```
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="ai-msg-content">
      {parts.map((part, i) => {
        const codeMatch = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
        if (codeMatch) {
          const lang = codeMatch[1] || "text";
          const code = codeMatch[2].trimEnd();
          const isExecutable = ["bash", "sh", "powershell", "ps1", "cmd", "shell"].includes(lang.toLowerCase());
          return (
            <div key={i} className="ai-code-block">
              <div className="ai-code-header">
                <span className="ai-code-lang">{lang}</span>
                <div className="ai-code-actions">
                  <button
                    className="ai-code-btn"
                    // Sem `.catch`, uma permissão de clipboard negada pelo
                    // navegador virava exceção não tratada — sem aviso
                    // nenhum ao usuário de que a cópia falhou.
                    onClick={() => void navigator.clipboard.writeText(code).catch(() => {})}
                    title="Copiar"
                    aria-label="Copiar código"
                  >
                    <Icon name="copy" size={13} />
                  </button>
                  {isExecutable && onRunCommand && (
                    <button
                      className="ai-code-btn ai-code-run"
                      onClick={() => onRunCommand(code)}
                      title="Executar no terminal"
                      aria-label="Executar no terminal"
                    >
                      <Icon name="play" size={13} />
                    </button>
                  )}
                </div>
              </div>
              <pre className="ai-code-pre"><code>{code}</code></pre>
            </div>
          );
        }
        // Texto normal — converte \n em <br>. As pontas são aparadas: o
        // texto ao redor de um bloco de código sempre carrega o \n\n que o
        // separava no markdown, e cada um vira um <br> — duas linhas em
        // branco somadas à margem do próprio bloco abriam um vão de ~40px
        // entre o código e o parágrafo seguinte.
        const linhas = part.split("\n");
        while (linhas.length && linhas[0].trim() === "") linhas.shift();
        while (linhas.length && linhas[linhas.length - 1].trim() === "") linhas.pop();
        return (
          <span key={i}>
            {linhas.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {line}
              </span>
            ))}
          </span>
        );
      })}
      {/* Cursor de digitação desenhado em CSS, não com o glifo ▋: a barra
          cheia depende de a fonte tê-la (nem toda tem) e herda a altura da
          linha, então ela pulava de tamanho conforme o texto ao redor. */}
      {streaming && <span className="ai-cursor" aria-hidden="true" />}
    </div>
  );
}
