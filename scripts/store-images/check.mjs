// Checks the Chrome Web Store images in docs/store/images/: five 1280 x 800 screenshots and one
// 440 x 280 promo tile, all 8-bit RGB PNGs with no alpha channel and no transparency chunk.
// Run with: node scripts/store-images/check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPng } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'docs/store/images');

const EXPECTED = [
  { match: /^[1-5]-.+\.png$/, count: 5, width: 1280, height: 800, what: 'screenshot' },
  { match: /^promo-tile-440x280\.png$/, count: 1, width: 440, height: 280, what: 'promo tile' },
];

const problems = [];
const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
const unknown = files.filter((f) => !EXPECTED.some((e) => e.match.test(f)));
for (const f of unknown) problems.push(`${f} is not a listed store image`);

for (const { match, count, width, height, what } of EXPECTED) {
  const found = files.filter((f) => match.test(f));
  if (found.length !== count) problems.push(`expected ${count} ${what} file(s), found ${found.length}`);
  for (const f of found) {
    const info = inspectPng(path.join(dir, f));
    const size = `${info.width} x ${info.height}`;
    console.log(
      `${f}  ${size}  ${info.bitDepth}-bit ${info.colorName}  pixel data has no alpha: ${info.pixelBytesMatchRgb}`,
    );
    if (info.width !== width || info.height !== height)
      problems.push(`${f} is ${size}, expected ${width} x ${height}`);
    if (info.hasAlphaType) problems.push(`${f} has an alpha channel (${info.colorName})`);
    if (info.hasTransparencyChunk) problems.push(`${f} has a tRNS transparency chunk`);
    if (!info.pixelBytesMatchRgb) problems.push(`${f} pixel data is not plain 8-bit RGB`);
    if (info.interlace) problems.push(`${f} is interlaced`);
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nOK: 5 screenshots and 1 promo tile, right sizes, no alpha channel.');
