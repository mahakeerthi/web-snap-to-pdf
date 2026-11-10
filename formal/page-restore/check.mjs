// Runs the PageRestore TLA+ model and reports drift in the code it describes.
// Usage: node formal/page-restore/check.mjs [--trace] [--sync]
//   exit 0  every config matches its expected result and no covered function changed
//   exit 1  a config result differs from coverage.json (a new finding or a broken model)
//   exit 2  results match, but a covered function changed since the sync: review the model,
//           then rerun with --sync to record the new hashes
//   exit 3  the check could not run: no Java, a missing or unexpected jar, TLC output without a
//           result, or a covered function that no longer exists
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const coveragePath = path.join(here, 'coverage.json');
const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
const jar = path.join(root, 'tools/tla2tools.jar');
const javaCandidates = ['/opt/homebrew/opt/openjdk/bin/java', '/usr/local/opt/openjdk/bin/java', 'java'];
const java = process.env.JAVA
  ? isRunnable(process.env.JAVA) && process.env.JAVA
  : javaCandidates.find(isRunnable);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function fail(message) {
  console.error(message);
  process.exit(3);
}

// The text of `function name(` up to the closing brace at the same indent, or null.
function functionText(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*(async\\s+)?function ${name}\\(`).test(l));
  if (start < 0) return null;
  const indent = lines[start].match(/^\s*/)[0];
  const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
  if (end < 0) return null;
  return lines.slice(start, end + 1).join('\n');
}

function hashes() {
  const out = {};
  for (const [file, names] of Object.entries(coverage.functions)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const name of names) {
      const text = functionText(source, name);
      out[`${file}#${name}`] = text && sha256(text).slice(0, 16);
    }
  }
  return out;
}

function isRunnable(cmd) {
  try {
    execFileSync(cmd, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function runTlc(cfg) {
  const metadir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlc-'));
  let output;
  try {
    output = execFileSync(
      java,
      ['-cp', jar, 'tlc2.TLC', '-workers', '1', '-metadir', metadir, '-config', cfg, 'PageRestore.tla'],
      { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    output = String(err.stdout || '') + String(err.stderr || '');
  } finally {
    fs.rmSync(metadir, { recursive: true, force: true });
  }
  const violated = output.match(/Invariant (\w+) is violated/);
  if (violated) return { result: `violation:${violated[1]}`, output };
  if (/Model checking completed. No error has been found/.test(output)) return { result: 'pass', output };
  return { result: null, output };
}

if (!java) fail('No runnable Java. Install one (brew install openjdk) or set JAVA=/path/to/java.');
if (!fs.existsSync(jar)) {
  fail(
    `Missing ${path.relative(root, jar)}. Download TLA+ ${coverage.tlaVersion}:\n` +
      `  mkdir -p tools && curl -sSL -o tools/tla2tools.jar ${coverage.tlaJarUrl}`,
  );
}
const jarSha = sha256(fs.readFileSync(jar));
if (jarSha !== coverage.tlaJarSha256) {
  fail(
    `${path.relative(root, jar)} has sha256 ${jarSha}, but coverage.json pins TLA+ ${coverage.tlaVersion} ` +
      `(${coverage.tlaJarSha256}). Download it again from ${coverage.tlaJarUrl}`,
  );
}

const now = hashes();
const missing = Object.keys(now).filter((k) => !now[k]);
for (const k of missing) console.log(`! missing: ${k}`);
if (missing.length) {
  fail(
    'A covered function was renamed, removed or reformatted. Update coverage.json `functions` ' +
      'and the model, then sync.',
  );
}

if (process.argv.includes('--sync')) {
  const files = Object.keys(coverage.functions);
  const clean = git('status', '--porcelain', '--', ...files) === '';
  coverage.hashes = now;
  coverage.syncCommit = git('rev-parse', '--short', 'HEAD') + (clean ? '' : '+working-tree');
  fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2) + '\n');
  console.log(`Recorded hashes at ${coverage.syncCommit}.`);
  process.exit(0);
}

let mismatch = false;
for (const [cfg, expected] of Object.entries(coverage.expect)) {
  const { result, output } = runTlc(cfg);
  if (!result) fail(`TLC gave no result for ${cfg}. Its output:\n${output}`);
  const ok = result === expected;
  mismatch ||= !ok;
  console.log(`${ok ? '✓' : '✗'} ${cfg}: ${result} (expected ${expected})`);
  if (!ok || process.argv.includes('--trace'))
    console.log(output.slice(output.indexOf('Error:') >= 0 ? output.indexOf('Error:') : 0));
}

const drift = Object.keys(now).filter((k) => now[k] !== coverage.hashes[k]);
for (const k of drift) console.log(`! changed since sync ${coverage.syncCommit}: ${k}`);

process.exit(mismatch ? 1 : drift.length ? 2 : 0);
