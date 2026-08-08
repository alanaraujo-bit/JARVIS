# JARVIS Guardian — Claude Session Window Manager

Serviço 24/7 que acompanha as janelas de utilização das contas Claude Code do
JARVIS e manda um **"oi"** (modelo **haiku**, o mais barato/leve) nas contas
ociosas, para que a janela de cota de 5h fique **sempre rolando**.

**Por quê:** a janela de 5h da Anthropic só existe enquanto a conta tem uso
recente. Conta ociosa = janela parada. Quando o usuário senta para usar, a
janela nasce do zero e ele espera ~4h ao bater no limite. Com o guardião, a
janela nunca morre: quando o usuário usa, já existe uso antigo prestes a
expirar — a espera cai para uma fração do tempo.

## Algoritmo inteligente (por conta, a cada ciclo)

1. Consulta a cota real (`GET api.anthropic.com/api/oauth/usage` com o token
   OAuth da conta — o mesmo endpoint que a CLI usa em `/usage`).
2. Classifica o estado:
   - **Bloqueio mensal de gasto** → pausa total, re-checa em 6h, notifica.
   - **Limite semanal (7d) em 100%** → não pinga; acorda exatamente no
     `resets_at` semanal + margem para notificar "liberou" e renovar.
   - **Sem janela 5h** (`resets_at` nulo/no passado ou uso 0%) → **pinga agora**
     (se o usuário não estiver usando e respeitando o intervalo mínimo).
   - **Janela 5h ativa** → calcula `falta = resets_at - agora`:
     - `falta <= margem (60s)` → pinga (renova a janela);
     - senão → **dorme exatamente até `resets_at + margem`**. Nunca pinga
       antes, nunca gasta ping à toa — o "três horas e um minuto" do pedido.
3. **Nunca pinga** quando: o JARVIS sinalizou uso ativo (lease/heartbeat),
   a conta está travada (semanal/mensal), ou o último ping foi há menos que
   o intervalo mínimo (trava anti-loop).
4. Falha do ping (JSON da CLI, `--output-format json`) é classificada:
   `weekly limit` / `monthly spend limit` / sessão expirada / outro → cada
   uma com seu tratamento e notificação.

## API

Todas as rotas exigem `Authorization: Bearer <JARVIS_GUARDIAN_TOKEN>`
(menos a página `/` e `/api/health`).

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/api/health` | heartbeat |
| GET | `/api/status` | estado de todas as contas (cota, pings, próxima ação) |
| POST | `/api/accounts` | cadastra conta `{ id, name, credentialsJson }` |
| DELETE | `/api/accounts/:id` | remove conta |
| PATCH | `/api/accounts/:id` | `{ enabled }` ou `{ name }` |
| POST | `/api/accounts/:id/lease` | heartbeat "estou usando" (JARVIS, 2 min) |
| POST | `/api/accounts/:id/ping` | força um ping no próximo ciclo |
| GET | `/api/push/vapid` | chave pública VAPID (sem auth — o PWA precisa antes do token) |
| POST | `/api/push/subscribe` | registra o aparelho `{ subscription }` para Web Push |
| DELETE | `/api/push/subscribe` | remove o aparelho `{ endpoint }` |

Nenhuma rota devolve token: credenciais entram, nunca saem.

### Cadastro manual (teste rápido)

```bash
# Lê o .credentials.json da conta e envia para o guardião
CRED=$(cat ~/.claude/.credentials.json)
curl -X POST https://SEU-APP.up.railway.app/api/accounts \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"id\":\"acc-teste\",\"name\":\"Minha Conta\",\"credentialsJson\":$(node -e 'console.log(JSON.stringify(require("fs").readFileSync(process.env.HOME+"/.claude/.credentials.json","utf8")))')}"
```

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
| --- | --- | --- | --- |
| `JARVIS_GUARDIAN_TOKEN` | sim | — | token da API REST (mín. 16 chars) |
| `JARVIS_GUARDIAN_SECRET` | sim | — | chave de criptografia das credenciais (mín. 16 chars) |
| `PORT` | Railway injeta | 3000 | porta HTTP |
| `DATA_DIR` | — | `./data` | onde ficam contas + estado (usar volume no Railway) |
| `PING_MARGIN_MS` | — | 60000 | precisão do agendamento (renova com 1 min de folga) |
| `MIN_PING_INTERVAL_MS` | — | 600000 | intervalo mínimo entre pings da mesma conta |
| `PING_MODEL` | — | `haiku` | modelo dos "oi" |
| `PING_PROMPT` | — | `oi` | texto do ping |
| `CLAUDE_BIN` | — | `claude` | binário da CLI |
| `VAPID_PUBLIC_KEY` | p/ push | — | chave pública VAPID (notificações no celular) |
| `VAPID_PRIVATE_KEY` | p/ push | — | chave privada VAPID (só no ambiente) |
| `VAPID_SUBJECT` | p/ push | — | `mailto:` seu, exigido pelo provedor de push |

## Deploy no Railway

1. Aponte um **novo serviço** para a pasta `guardian/` (ou um repositório que
   a contenha); o Dockerfile é detectado automaticamente.
2. Crie um **Volume** e monte em `/app/data` (as credenciais precisam
   sobreviver a redeploys).
3. Variáveis: `JARVIS_GUARDIAN_TOKEN` e `JARVIS_GUARDIAN_SECRET` (gere com
   `openssl rand -hex 32`), `DATA_DIR=/app/data`.
4. O Dockerfile instala a CLI `claude` (`@anthropic-ai/claude-code`).
5. Acesse `https://SEU-APP.up.railway.app/` — a página de status ao vivo.
6. Cadastre as contas (painel do JARVIS, Fase 2, ou curl acima) e acompanhe.

## No celular

1. Abra `https://jarvis-guardian-production.up.railway.app` no navegador do
   celular (Chrome/Edge no Android; Safari no iPhone).
2. Digite o token (`JARVIS_GUARDIAN_TOKEN`) na tela de entrada — **só uma
   vez**: ele fica salvo no aparelho, e o botão **sair** (rodapé) é o único
   jeito de trocar.
3. Toque em **Ativar** no cartão de notificações (permita a permissão).
4. No Android: "Adicionar à tela inicial" para instalar como app.
   No iPhone: Safari → Compartilhar → "Adicionar à Tela de Início" (Web Push
   no iOS exige o app instalado na tela inicial).

**Pensado para iPhone:** abertura instantânea (a última tela sai do cache
local no mesmo quadro e a atualização chega atrás), sem zoom por pinça ou
duplo-toque, e a barra de status (hora/bateria) respeita as margens seguras
em vez de cobrir o conteúdo.

> Nota iOS: o app instalado na tela inicial tem **armazenamento separado** do
> Safari. Se você digitou o token no navegador e depois instalou, o app
> instalado pede o token uma vez — depois nunca mais.

## Fases

- [x] **Fase 0** — spike local validou: CLI headless funciona, API de cota
  funciona com o token OAuth, conta ociosa = `five_hour` nulo/0%.
- [x] **Fase 1** — guardião (este código): agendador, pinger, API, página.
- [x] **Fase 1b** — deploy no Railway + primeiro ping real validado.
- [x] **Fase 3** — PWA instalável + notificações Web Push no celular.
- [x] **Fase 2** — painel no JARVIS (menu lateral → **Guardião**): cadastro das
  contas em um clique (credenciais lidas do próprio JARVIS e entregues ao
  guardião, criptografadas em repouso), status ao vivo das janelas 5h/7d com
  contagem regressiva, pausar/retomar, "pingar agora", remover — e o
  **heartbeat**: enquanto há terminal aberto numa conta, o JARVIS renova o
  lease dela a cada minuto e o guardião não pinga conta em uso.
