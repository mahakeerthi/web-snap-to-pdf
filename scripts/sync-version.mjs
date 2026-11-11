// Copies package.json's version into extension/manifest.json. `npm version` runs this as the
// `version` lifecycle script, after it bumps package.json and before it commits and tags, so the
// release commit carries both files at the same version.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'extension/manifest.json');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`package.json version ${version} is not X.Y.Z. Chrome accepts only dot-separated integers.`);
  process.exit(1);
}

// Replace the one field in place so the manifest keeps its hand-kept formatting.
const text = fs.readFileSync(manifestPath, 'utf8');
const field = /^(\s*"version":\s*")[^"]*(")/m;
if (!field.test(text)) {
  console.error('extension/manifest.json has no "version" field.');
  process.exit(1);
}
fs.writeFileSync(manifestPath, text.replace(field, `$1${version}$2`));
console.log(`extension/manifest.json -> ${version}`);

if (process.env.npm_lifecycle_event === 'version') {
  execFileSync('git', ['add', manifestPath], { cwd: root, stdio: 'inherit' });
}
