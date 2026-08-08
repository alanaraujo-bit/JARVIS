/**
 * Service worker do PWA do guardião.
 *
 * Dois trabalhos:
 *  1. Abrir instantâneo — a concha (HTML/CSS/JS) sai do cache no mesmo
 *     quadro; a rede só serve para o que importa (status e push).
 *  2. Receber Web Push — é o que entrega "conta X liberou!" no celular
 *     mesmo com o app fechado e o PC desligado.
 */

// v2: nova concha com tela de token, margens seguras e viewport sem zoom.
const CACHE = "jarvis-guardian-v2";
const CONCHA = ["/", "/index.html", "/manifest.webmanifest", "/icon-256.png", "/icon-512.png"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(CONCHA))
      .then(() => self.skipWaiting()),
  );
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
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // A API nunca pode vir do cache: o status ao vivo precisa ser fresco, e um
  // `/api/status` velho mostraria dados de ontem para sempre.
  if (url.pathname.startsWith("/api/")) return;
  ev.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const chave = req.mode === "navigate" ? "/index.html" : req;
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

/* ---------------------------- notificações push --------------------------- */

self.addEventListener("push", (ev) => {
  let dados = { title: "JARVIS", body: "Notificação do guardião", url: "/" };
  try {
    if (ev.data) dados = { ...dados, ...JSON.parse(ev.data.text()) };
  } catch {
    /* corpo não-JSON: usa o padrão */
  }
  ev.waitUntil(
    self.registration.showNotification(dados.title, {
      body: dados.body,
      icon: "/icon-256.png",
      badge: "/icon-256.png",
      tag: "jarvis-guardian",
      data: { url: dados.url },
    }),
  );
});

self.addEventListener("notificationclick", (ev) => {
  ev.notification.close();
  const url = ev.notification.data?.url ?? "/";
  ev.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((janelas) => {
      for (const j of janelas) {
        if ("focus" in j) {
          j.navigate(url).catch(() => {});
          j.focus();
          return;
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
