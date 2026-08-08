/**
 * Criptografia das credenciais em repouso (AES-256-GCM).
 *
 * As contas Claude Code guardam um token OAuth que dá acesso pleno à conta.
 * No disco do guardião eles ficam criptografados com a chave `JARVIS_GUARDIAN_SECRET`
 * (que só existe no ambiente). A única exceção é a cópia de trabalho que a CLI
 * `claude` precisa ler — ela é escrita em disco (e com permissão 600) só na
 * hora do ping, dentro do diretório da conta.
 *
 * Formato do payload: `iv.tag.dados` em base64.
 */

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

function chave(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

export function encrypt(plain: string, secret: string): string {
  const key = chave(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string, secret: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGO, chave(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
