/**
 * Modal de configuração do provedor de IA.
 *
 * Permite trocar provedor, endpoint, API key, modelo e parâmetros.
 * Aparece embutido dentro do AiPanel.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAiStore, PROVIDER_DEFAULTS, type AiProvider } from "../stores/aiStore";

const PROVIDERS: { value: AiProvider; label: string; needsKey: boolean }[] = [
  { value: "ollama", label: "Ollama (local)", needsKey: false },
  { value: "openai", label: "OpenAI", needsKey: true },
  { value: "anthropic", label: "Anthropic", needsKey: true },
  { value: "gemini", label: "Google Gemini", needsKey: true },
];

export function AiSettings() {
  const { config, setConfig, availableModels, modelsError, fetchModels, toggleSettings } =
    useAiStore();

  const [localConfig, setLocalConfig] = useState({ ...config });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Lista os modelos com a config que está na tela, não com a salva: sem
  // isso, digitar uma chave nova e clicar em "Testar" consultaria o provedor
  // com a chave antiga.
  useEffect(() => {
    void fetchModels(config);
    // Só na abertura — refazer a cada tecla digitada no campo de endpoint
    // dispararia uma consulta por caractere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Chaves já digitadas, por provedor.
   *
   * Trocar de provedor zerava a chave: quem tinha a OpenAI configurada,
   * espiava "Anthropic" no seletor e voltava, salvava por cima com a chave
   * vazia. Guardar por provedor faz a ida e volta ser inofensiva — e ainda
   * permite manter duas contas configuradas ao mesmo tempo.
   */
  const chaves = useRef<Partial<Record<AiProvider, string>>>({ [config.provider]: config.apiKey });

  const handleProviderChange = useCallback((provider: AiProvider) => {
    setLocalConfig((prev) => {
      chaves.current[prev.provider] = prev.apiKey;
      const defaults = PROVIDER_DEFAULTS[provider];
      return {
        ...prev,
        provider,
        endpoint: defaults.endpoint,
        model: defaults.model,
        apiKey: chaves.current[provider] ?? "",
      };
    });
  }, []);

  /** Campos vazios que impediriam a configuração de funcionar. */
  const problema = (() => {
    if (!localConfig.endpoint.trim()) return "Informe o endpoint do provedor.";
    if (!localConfig.model.trim()) return "Informe o modelo.";
    const precisaChave = PROVIDERS.find((p) => p.value === localConfig.provider)?.needsKey;
    if (precisaChave && !localConfig.apiKey.trim()) return "Este provedor exige uma chave de API.";
    return null;
  })();

  const handleSave = useCallback(() => {
    setConfig(localConfig);
    toggleSettings();
  }, [localConfig, setConfig, toggleSettings]);

  /**
   * Testa com o que está na tela, sem salvar. Salvar antes de saber se
   * funciona trocaria uma configuração boa por uma quebrada só porque o
   * usuário quis conferir uma chave.
   */
  const handleTest = useCallback(async () => {
    if (problema) {
      setTestResult(`❌ ${problema}`);
      return;
    }
    setTesting(true);
    setTestResult(null);
    await fetchModels(localConfig);
    const erro = useAiStore.getState().modelsError;
    const total = useAiStore.getState().availableModels.length;
    setTestResult(erro ? `❌ ${erro}` : `✅ Conexão OK — ${total} modelo(s) disponíveis.`);
    setTesting(false);
  }, [localConfig, fetchModels, problema]);

  const currentProvider = PROVIDERS.find((p) => p.value === localConfig.provider)!;

  return (
    <div className="ai-settings">
      <div className="ai-settings-header">
        <span>Configurações de IA</span>
        <button className="ai-settings-close" onClick={toggleSettings}>×</button>
      </div>

      <div className="ai-settings-body">
        {/* Provedor */}
        <label className="ai-field">
          <span className="ai-field-label">Provedor</span>
          <select
            className="ai-field-select"
            value={localConfig.provider}
            onChange={(e) => handleProviderChange(e.target.value as AiProvider)}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>

        {/* Endpoint */}
        <label className="ai-field">
          <span className="ai-field-label">Endpoint</span>
          <input
            className="ai-field-input"
            type="text"
            value={localConfig.endpoint}
            onChange={(e) => setLocalConfig((p) => ({ ...p, endpoint: e.target.value }))}
            placeholder={PROVIDER_DEFAULTS[localConfig.provider].endpoint}
          />
        </label>

        {/* API Key */}
        {currentProvider.needsKey && (
          <label className="ai-field">
            <span className="ai-field-label">API Key</span>
            <input
              className="ai-field-input"
              type="password"
              value={localConfig.apiKey}
              onChange={(e) => setLocalConfig((p) => ({ ...p, apiKey: e.target.value }))}
              placeholder="sk-..."
            />
          </label>
        )}

        {/* Modelo */}
        <label className="ai-field">
          <span className="ai-field-label">Modelo</span>
          <div className="ai-field-combo">
            <input
              className="ai-field-input"
              type="text"
              value={localConfig.model}
              onChange={(e) => setLocalConfig((p) => ({ ...p, model: e.target.value }))}
              placeholder={PROVIDER_DEFAULTS[localConfig.provider].model}
              list="ai-models-list"
            />
            {availableModels.length > 0 && (
              <datalist id="ai-models-list">
                {availableModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
          </div>
        </label>

        {/* Temperatura */}
        <label className="ai-field">
          <span className="ai-field-label">Temperatura: {localConfig.temperature.toFixed(1)}</span>
          <input
            className="ai-field-range"
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={localConfig.temperature}
            onChange={(e) => setLocalConfig((p) => ({ ...p, temperature: parseFloat(e.target.value) }))}
          />
        </label>

        {/* Max Tokens */}
        <label className="ai-field">
          <span className="ai-field-label">Max tokens</span>
          <input
            className="ai-field-input"
            type="number"
            min="100"
            max="32000"
            step="100"
            value={localConfig.maxTokens}
            onChange={(e) => setLocalConfig((p) => ({ ...p, maxTokens: parseInt(e.target.value) || 2048 }))}
          />
        </label>

        {/* Teste */}
        {testResult && <div className="ai-test-result">{testResult}</div>}
        {!testResult && modelsError && (
          <div className="ai-test-result">❌ {modelsError}</div>
        )}

        {problema && <div className="ai-field-hint">{problema}</div>}

        <div className="ai-settings-actions">
          <button className="ai-settings-btn secondary" onClick={toggleSettings}>
            Cancelar
          </button>
          <button
            className="ai-settings-btn secondary"
            onClick={handleTest}
            disabled={testing || !!problema}
          >
            {testing ? "Testando..." : "Testar conexão"}
          </button>
          <button
            className="ai-settings-btn primary"
            onClick={handleSave}
            disabled={!!problema}
            title={problema ?? "Salvar configuração"}
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
