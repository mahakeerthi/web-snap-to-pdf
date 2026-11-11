// Prints the next release version from the existing release tags.
// Run with: git tag -l | node scripts/next-version.mjs <patch|minor|major>
// Versions come from tags, not from main: main stays at 0.0.0 and only tagged release commits
// carry a real version, so releasing never needs to push to main.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(tags, bump) {
  const versions = tags
    .map((t) => RELEASE_TAG.exec(t.trim().replace(/^refs\/tags\//, '')))
    .filter(Boolean)
    .map((m) => m.slice(1).map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [major, minor, patch] = versions.at(-1) ?? [0, 0, 0];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump "${bump}". Use patch, minor or major.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(nextVersion(fs.readFileSync(0, 'utf8').split('\n'), process.argv[2]));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
