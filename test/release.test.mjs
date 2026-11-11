// Release tooling: `npm version` keeps package.json and the manifest in step, and the next
// version follows the release tags. Run with: npm run test:release
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextVersion } from '../scripts/next-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('npm version bumps package.json and the manifest in one tagged commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'websnap-release-'));
  try {
    for (const file of [
      'package.json',
      'package-lock.json',
      'extension/manifest.json',
      'scripts/sync-version.mjs',
    ]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(dir, file));
    }
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    git('add', '.');
    git('commit', '-qm', 'base');
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    const [major, minor, patch] = before.split('.').map(Number);
    const expected = `${major}.${minor}.${patch + 1}`;

    execFileSync('npm', ['version', 'patch', '-m', 'Release v%s'], { cwd: dir, stdio: 'pipe' });

    const manifestText = fs.readFileSync(path.join(dir, 'extension/manifest.json'), 'utf8');
    assert.equal(JSON.parse(manifestText).version, expected, 'manifest follows package.json');
    assert.equal(git('describe', '--tags', '--exact-match'), `v${expected}`, 'HEAD is tagged');
    assert.equal(git('log', '-1', '--format=%s'), `Release v${expected}`);
    assert.deepEqual(
      git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(),
      ['extension/manifest.json', 'package-lock.json', 'package.json'],
      'the release commit holds all three version files',
    );
    assert.equal(git('status', '--porcelain'), '', 'nothing left uncommitted');
    const original = fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8');
    assert.equal(
      manifestText,
      original.replace(`"version": "${before}"`, `"version": "${expected}"`),
      'only the version line changed',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the first release from no tags is 0.0.1', () => {
  assert.equal(nextVersion([], 'patch'), '0.0.1');
  assert.equal(nextVersion([''], 'minor'), '0.1.0');
});

test('nextVersion bumps the highest release tag numerically', () => {
  const tags = ['v0.0.9', 'v0.0.10', 'v0.0.2', 'refs/tags/v0.0.3'];
  assert.equal(nextVersion(tags, 'patch'), '0.0.11');
  assert.equal(nextVersion(tags, 'minor'), '0.1.0');
  assert.equal(nextVersion(tags, 'major'), '1.0.0');
});

test('nextVersion ignores tags that are not releases', () => {
  assert.equal(nextVersion(['v9.9.9-beta', 'latest', 'v1.2', 'x1.0.0', 'v0.1.0'], 'patch'), '0.1.1');
});

test('nextVersion rejects an unknown bump', () => {
  assert.throws(() => nextVersion([], 'huge'), /Unknown bump/);
});
