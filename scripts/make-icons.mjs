// Draws the menu bar's envelope as PNGs, so there's no binary design file to keep: a template image (black with
// alpha), which macOS tints for light and dark menu bars. The app icon is build/icon.svg; scripts/render-icon.mjs
// turns it into build/icon.png.
//   node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function png(size, draw, rgba) {
  const px = rgba ?? new Uint8Array(size * size * 4);
  const set = (x, y, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) {return;}
    const i = (Math.floor(y) * size + Math.floor(x)) * 4;
    px[i + 3] = Math.max(px[i + 3], Math.round(a * 255));
  };
  if (draw) {draw(set, size);}
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) {c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;}
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xff_ff_ff_ff;
    for (const b of buf) {c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);}
    return (c ^ 0xff_ff_ff_ff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** An envelope: a rounded outline with a V for the flap. */
function envelope(set, size) {
  const s = size / 16;
  const [l, r, t, b] = [1.5 * s, 14.5 * s, 3.5 * s, 12.5 * s];
  const w = 1.1 * s;
  const line = (x0, y0, x1, y1) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 4);
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * i) / steps;
      for (let dx = -w / 2; dx <= w / 2; dx += 0.25) {
        for (let dy = -w / 2; dy <= w / 2; dy += 0.25) {
          set(x + dx, y + dy, 1);
        }
      }
    }
  };
  line(l, t, r, t);
  line(r, t, r, b);
  line(r, b, l, b);
  line(l, b, l, t);
  line(l, t, size / 2, 8.6 * s);
  line(size / 2, 8.6 * s, r, t);
}

writeFileSync('src/main/assets/trayTemplate.png', png(16, envelope));
writeFileSync('src/main/assets/trayTemplate@2x.png', png(32, envelope));
console.log('icons written');
