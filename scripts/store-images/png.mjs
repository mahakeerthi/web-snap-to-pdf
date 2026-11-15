// Reads just enough of a PNG to prove its size and that it carries no alpha channel.
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const COLOR_NAMES = { 0: 'gray', 2: 'RGB', 3: 'palette', 4: 'gray+alpha', 6: 'RGBA' };

export function inspectPng(file) {
  const buf = fs.readFileSync(file);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${file} is not a PNG`);
  const chunks = [];
  const idat = [];
  let header = null;
  for (let pos = 8; pos < buf.length;) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR')
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    if (type === 'IDAT') idat.push(data);
    chunks.push(type);
    pos += 12 + length;
  }
  if (!header) throw new Error(`${file} has no IHDR chunk`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerPixel = (CHANNELS[header.colorType] * header.bitDepth) / 8;
  const expectedRaw = header.height * (1 + header.width * bytesPerPixel);
  return {
    ...header,
    colorName: COLOR_NAMES[header.colorType] ?? `type ${header.colorType}`,
    hasAlphaType: header.colorType === 4 || header.colorType === 6,
    hasTransparencyChunk: chunks.includes('tRNS'),
    pixelBytesMatchRgb: header.colorType === 2 && header.bitDepth === 8 && raw.length === expectedRaw,
  };
}
