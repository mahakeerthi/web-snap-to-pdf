// Rasterizes icons/icon.svg into the PNG sizes the manifest needs, using headless Chromium.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'extension/icons/icon.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace(/width="128" height="128"/, `width="${size}" height="${size}"`)}</body></html>`,
  );
  const buf = await page.locator('svg').screenshot({ omitBackground: true });
  fs.writeFileSync(path.join(root, `extension/icons/icon${size}.png`), buf);
  console.log(`icons/icon${size}.png ${buf.length} bytes`);
}
await browser.close();
