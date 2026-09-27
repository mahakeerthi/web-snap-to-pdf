// Validates extension/_locales/*/messages.json against the English reference:
// valid JSON, identical key sets, every English $N placeholder kept, no empty or stray-$ messages,
// and extDescription within the Chrome Web Store's 132-character limit. Exits 1 on any problem.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension/_locales');
const REFERENCE = 'en';
const DESCRIPTION_LIMIT = 132;

const problems = [];
const report = (code, msg) => problems.push(`${code}: ${msg}`);

function load(code) {
  const file = path.join(LOCALES_DIR, code, 'messages.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('top level is not an object');
    return data;
  } catch (err) {
    report(code, `cannot load ${path.relative(process.cwd(), file)} (${err.message})`);
    return null;
  }
}

const placeholders = (s) => [...new Set(s.match(/\$\d+/g) || [])];

const codes = fs
  .readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort((a, b) => (a === REFERENCE ? -1 : b === REFERENCE ? 1 : a.localeCompare(b)));

const en = load(REFERENCE);
if (!en) {
  console.error(problems.join('\n'));
  process.exit(1);
}
const enKeys = Object.keys(en);

for (const code of codes) {
  const dict = code === REFERENCE ? en : load(code);
  if (!dict) {
    console.log(`FAIL ${code.padEnd(6)} invalid JSON`);
    continue;
  }
  const before = problems.length;

  if (code !== REFERENCE) {
    const missing = enKeys.filter((k) => !(k in dict));
    const extra = Object.keys(dict).filter((k) => !(k in en));
    if (missing.length) report(code, `missing keys: ${missing.join(', ')}`);
    if (extra.length) report(code, `extra keys: ${extra.join(', ')}`);
  }

  for (const [key, entry] of Object.entries(dict)) {
    const msg = entry && entry.message;
    if (typeof msg !== 'string' || !msg.trim()) {
      report(code, `${key} has an empty or missing message`);
      continue;
    }
    // Chrome i18n treats $ specially: only $N (or $$ for a literal dollar sign) is allowed.
    if (/\$(?!\d|\$)/.test(msg.replace(/\$\$/g, ''))) report(code, `${key} contains a stray "$"`);
    if (code !== REFERENCE && en[key]?.message) {
      const lost = placeholders(en[key].message).filter((p) => !placeholders(msg).includes(p));
      if (lost.length) report(code, `${key} is missing placeholder ${lost.join(', ')}`);
    }
  }

  const desc = dict.extDescription?.message;
  if (typeof desc === 'string') {
    const len = Array.from(desc).length;
    if (len > DESCRIPTION_LIMIT)
      report(code, `extDescription is ${len} characters (limit ${DESCRIPTION_LIMIT})`);
  }

  const count = problems.length - before;
  console.log(
    `${count ? 'FAIL' : 'ok  '} ${code.padEnd(6)} ${Object.keys(dict).length} keys, extDescription ${Array.from(desc || '').length} chars`,
  );
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`\nAll ${codes.length} locales match ${REFERENCE} (${enKeys.length} keys).`);
