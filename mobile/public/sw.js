/**
 * Service worker do app do celular.
 *
 * O trabalho dele aqui é menor do que o de um PWA comum, e vale entender por
 * quê: este app não tem dados próprios para guardar, não faz chamada de API e
 * não funciona offline em nenhum sentido útil — sem o computador do outro
 * lado não existe terminal nenhum para mostrar. O que ele resolve é uma coisa
 * só, e ela é sentida: **abrir instantâneo**.
 *
 * Sem service worker, cada abertura espera o túnel da Cloudflare responder
 * antes de pintar o primeiro pixel — algumas centenas de milissegundos de
 * tela branca antes mesmo de o WebSocket começar. Com ele, a interface aparece
 * do cache no mesmo quadro e a rede só é usada para o que ela sabe fazer: os
 * bytes do terminal.
 *
 * A estratégia é "responde do cache, revalida atrás": a tela nunca espera a
 * rede, e a versão nova entra na abertura seguinte. Numa tela cujo conteúdo
 * inteiro vem por WebSocket, um HTML de ontem não mostra nada de errado.
 */

const CACHE = "jarvis-app-v1";

/** O app inteiro. Se algum destes faltar, não há tela. */
const CONCHA = ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (ev) => {
  // `skipWaiting` porque não há estado a preservar entre versões: nenhuma aba
  // aberta guarda dado que uma versão nova possa corromper.
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(CONCHA)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  // Só GET da própria origem. Um POST ou um recurso de fora não tem nada que
  // fazer neste cache, e interceptá-los só criaria caminhos para errar.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  ev.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // Uma navegação pede "/index.html" ou "/" dependendo do navegador; o
      // cache guarda "/". Normalizar aqui evita um miss que faria a tela
      // branca voltar justamente na abertura que o cache existe para acelerar.
      const chave = req.mode === "navigate" ? "/" : req;
      const guardado = await cache.match(chave);

      const rede = fetch(req)
        .then((resp) => {
          if (resp.ok) cache.put(chave, resp.clone());
          return resp;
        })
        .catch(() => guardado);

      return guardado || rede;
    }),
  );
});
