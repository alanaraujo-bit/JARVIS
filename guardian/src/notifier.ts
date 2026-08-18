/**
 * Notificações Web Push — é o que faz o celular saber na hora que uma conta
 * liberou, que travou, que o "oi" falhou, etc., mesmo com o PC desligado.
 *
 * O guardião guarda as inscrições dos aparelhos (no volume, em push-subs.json)
 * e envia via web-push com as chaves VAPID. Inscrições que o provedor de push
 * rejeita (410/404 — aparelho desinstalou o PWA) são removidas sozinhas.
 */

import webpush from "web-push";

import type { PushSub, Store } from "./store.js";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export class Notifier {
  private readonly habilitado: boolean;

  constructor(
    private readonly store: Store,
    private readonly vapid: VapidConfig,
  ) {
    this.habilitado = Boolean(vapid.publicKey && vapid.privateKey);
    if (this.habilitado) {
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    } else {
      console.warn("[guardian] VAPID_PUBLIC_KEY/PRIVATE_KEY ausentes — notificações desligadas");
    }
  }

  async notify(title: string, body: string, kind = "info", url = "/"): Promise<void> {
    if (!this.habilitado) return;
    const subs = this.store.listPushSubs();
    if (subs.length === 0) return;

    // `kind` chega ao service worker para preservar uma identidade visual e
    // uma pilha separada por tipo de alerta no sistema operacional.
    const payload = JSON.stringify({ title, body, kind, url });
    // TTL curto (1 dia): "janela liberou" atrasado demais não serve de nada.
    const opcoes = { TTL: 86_400 };
    const resultados = await Promise.allSettled(
      subs.map((s) => webpush.sendNotification(this.subscription(s), payload, opcoes)),
    );
    resultados.forEach((r, i) => {
      if (r.status === "rejected") {
        const codigo = (r.reason as { statusCode?: number })?.statusCode;
        if (codigo === 410 || codigo === 404) {
          this.store.removePushSub(subs[i].endpoint);
        }
      }
    });
  }

  private subscription(s: PushSub): webpush.PushSubscription {
    return { endpoint: s.endpoint, keys: s.keys, expirationTime: null };
  }
}
