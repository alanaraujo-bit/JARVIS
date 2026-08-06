/**
 * Formulário de configuração do Claude Code (modelo + esforço).
 *
 * Compartilhado entre o painel de Estatísticas e a tela de Configurações:
 * é a mesma edição de `~/.claude/settings.json` vista de dois lugares, e
 * dois formulários divergentes seriam duas fontes de verdade para a mesma
 * coisa.
 *
 * `configDir` ausente = a configuração principal (`~/.claude`), que é o que
 * a CLI usa para quem não cadastrou conta nenhuma.
 */

import { useCallback, useEffect, useState } from "react";

import { claudeSettingsGet, claudeSettingsSet } from "../lib/ipc";
import { Icon } from "./Icon";

const MODELOS_SUGERIDOS = ["sonnet", "opus", "haiku", "claude-sonnet-5", "claude-opus-5"];
const ESFORCOS_SUGERIDOS = ["low", "medium", "high", "max"];

interface Props {
  configDir?: string;
  /** Chamado depois de uma gravação bem-sucedida (para reler o uso, etc). */
  onSaved?: () => void;
}

export function ClaudeConfigForm({ configDir, onSaved }: Props) {
  const [modelo, setModelo] = useState("");
  const [esforco, setEsforco] = useState("");
  // O que veio do disco — a base para decidir se o formulário "mudou".
  const [salvo, setSalvo] = useState<{ modelo: string; esforco: string } | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Ignora respostas que chegam fora de ordem se o diretório mudar.
  useEffect(() => {
    let vivo = true;
    setModelo("");
    setEsforco("");
    setSalvo(null);
    setErro(null);
    void claudeSettingsGet(configDir)
      .then((s) => {
        if (!vivo) return;
        setModelo(s.model ?? "");
        setEsforco(s.effortLevel ?? "");
        // Base de comparação trimada, igual ao que o botão aplica: um valor
        // salvo com espaços acidentais não deve acender "Aplicar" à toa.
        setSalvo({ modelo: (s.model ?? "").trim(), esforco: (s.effortLevel ?? "").trim() });
      })
      .catch((e) => {
        if (vivo) setErro(String(e));
      });
    return () => {
      vivo = false;
    };
  }, [configDir]);

  const mudou =
    !!salvo && (modelo.trim() !== salvo.modelo || esforco.trim() !== salvo.esforco);

  const aplicar = useCallback(async () => {
    setSalvando(true);
    setErro(null);
    try {
      await claudeSettingsSet(configDir, modelo.trim() || undefined, esforco.trim() || undefined);
      setSalvo({ modelo: modelo.trim(), esforco: esforco.trim() });
      onSaved?.();
    } catch (e) {
      setErro(String(e));
    } finally {
      setSalvando(false);
    }
  }, [configDir, modelo, esforco, onSaved]);

  return (
    <div className="stats-claude-config">
      <label className="stats-claude-field">
        <span>Modelo</span>
        <input
          list="claude-config-modelos"
          value={modelo}
          onChange={(e) => setModelo(e.target.value)}
          placeholder="ex.: sonnet"
        />
        <datalist id="claude-config-modelos">
          {MODELOS_SUGERIDOS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      <label className="stats-claude-field">
        <span>Esforço</span>
        <input
          list="claude-config-esforcos"
          value={esforco}
          onChange={(e) => setEsforco(e.target.value)}
          placeholder="ex.: high"
        />
        <datalist id="claude-config-esforcos">
          {ESFORCOS_SUGERIDOS.map((e) => (
            <option key={e} value={e} />
          ))}
        </datalist>
      </label>

      <button className="chip" disabled={!mudou || salvando} onClick={() => void aplicar()}>
        {salvando ? "Aplicando…" : "Aplicar"}
      </button>

      {erro && (
        <p className="stats-empty" role="status">
          <Icon name="warning" size={13} /> {erro}
        </p>
      )}
    </div>
  );
}
