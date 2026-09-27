// Zips extension/ into dist/web-snap-pdf-<version>.zip for the Chrome Web Store, with
// manifest.json at the zip root. Uses the `zip` CLI (preinstalled on macOS and ubuntu runners).
// Run with: npm run package
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
const distDir = path.join(root, 'dist');

const { version } = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) {
  console.error(`Version mismatch: extension/manifest.json is ${version}, package.json is ${pkg.version}.`);
  process.exit(1);
}

const zipPath = path.join(distDir, `web-snap-pdf-${version}.zip`);
fs.mkdirSync(distDir, { recursive: true });
// `zip` updates an existing archive in place and never drops stale entries: start fresh.
fs.rmSync(zipPath, { force: true });
execFileSync('zip', ['-r', '-X', '-q', zipPath, '.', '-x', '.DS_Store', '*/.DS_Store'], {
  cwd: extDir,
  stdio: 'inherit',
});

const { size } = fs.statSync(zipPath);
console.log(`${path.relative(root, zipPath)} (${(size / 1024).toFixed(1)} KB)`);
