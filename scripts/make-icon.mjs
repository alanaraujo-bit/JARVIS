// Gera o PNG-base do ícone sem depender de editor gráfico ou de rede.
// A arte final (etapa 6) substitui este arquivo; aqui só garantimos que o
// bundler do Tauri tenha um ícone válido desde o primeiro build.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src-tauri/icons/source.png",
);

const BG = [11, 13, 18];
const ACCENT = [94, 234, 212];

const px = new Uint8Array(SIZE * SIZE * 4);
const c = SIZE / 2;
const rOuter = SIZE * 0.4;
const rInner = SIZE * 0.33;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const d = Math.hypot(x - c, y - c);

    // Anel externo + haste vertical descendo até um gancho: um "J" abstrato.
    const inRing = d <= rOuter && d >= rInner;
    const inStem =
      Math.abs(x - c) <= SIZE * 0.035 && y > c - rOuter && y < c + SIZE * 0.18;
    const on = inRing || inStem;

    // Antialias barato pela distância à borda do anel.
    let a = on ? 1 : 0;
    if (!on && d < rOuter + 1.5 && d > rInner - 1.5) {
      a = 1 - Math.min(Math.abs(d - rOuter), Math.abs(d - rInner)) / 1.5;
      a = Math.max(0, a);
    }

    const [r, g, b] = a > 0 ? ACCENT : BG;
    px[i] = Math.round(BG[0] + (r - BG[0]) * a);
    px[i + 1] = Math.round(BG[1] + (g - BG[1]) * a);
    px[i + 2] = Math.round(BG[2] + (b - BG[2]) * a);
    px[i + 3] = 255;
  }
}

// --- codificação PNG (RGBA, sem filtro) ---
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filtro None
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(
    raw,
    y * (SIZE * 4 + 1) + 1,
  );
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};

const table = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c2 = n;
    for (let k = 0; k < 8; k++) c2 = c2 & 1 ? 0xedb88320 ^ (c2 >>> 1) : c2 >>> 1;
    t[n] = c2;
  }
  return t;
})();

function crc32(buf) {
  let c2 = -1;
  for (let i = 0; i < buf.length; i++) c2 = table[(c2 ^ buf[i]) & 0xff] ^ (c2 >>> 8);
  return c2 ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // profundidade
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`ícone base gerado: ${OUT} (${png.length} bytes)`);
