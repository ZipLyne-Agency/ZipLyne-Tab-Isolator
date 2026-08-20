import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "src");
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
await mkdir(resolve(output, "icons"), { recursive: true });

for (const size of [16, 32, 48, 128]) {
  await writeFile(resolve(output, `icons/icon-${size}.png`), createIcon(size));
}

const manifest = JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8"));
console.log(`Built ${manifest.name} ${manifest.version} in ${output}`);

function createIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size * 0.45;
  const inner = size * 0.31;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const distance = Math.hypot(x - center, y - center);
      const green = distance <= radius;
      const whiteRing = distance <= inner && distance >= inner * 0.72;
      const whiteBar = Math.abs(x - center) < size * 0.055 && Math.abs(y - center) < size * 0.23;
      const whiteDot = Math.hypot(x - center, y - (center + size * 0.22)) < size * 0.065;
      const white = green && (whiteRing || whiteBar || whiteDot);
      pixels[offset] = white ? 255 : green ? 18 : 0;
      pixels[offset + 1] = white ? 255 : green ? 140 : 0;
      pixels[offset + 2] = white ? 255 : green ? 75 : 0;
      pixels[offset + 3] = green ? 255 : 0;
    }
  }
  return encodePng(size, size, pixels);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    rows[rowOffset] = 0;
    rgba.copy(rows, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
