// Checks docs/store/listing.md before it is pasted into the Chrome Web Store dashboard:
// the name and summary blocks match the English manifest strings, the summary fits the store's
// 132-character limit, and no search phrase appears more than five times in the description (the
// store treats more than five repeats of one keyword as keyword spam).
// Run with: node scripts/check-listing.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listing = fs.readFileSync(path.join(root, 'docs/store/listing.md'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'extension/_locales/en/messages.json'), 'utf8'));

const SUMMARY_LIMIT = 132;
const REPEAT_LIMIT = 5;
const PHRASES = [
  'webpage to pdf',
  'web page to pdf',
  'save as pdf',
  'print to pdf',
  'screenshot',
  'full page',
  'pdf',
];

// The first ```text block after the line that starts with the given bold label.
function block(label) {
  const lines = listing.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`**${label}`));
  if (start < 0) throw new Error(`listing.md has no "${label}" field`);
  const open = lines.findIndex((l, i) => i > start && l.startsWith('```text'));
  const close = lines.findIndex((l, i) => i > open && l.startsWith('```'));
  if (open < 0 || close < 0) throw new Error(`listing.md "${label}" has no text block`);
  return lines.slice(open + 1, close).join('\n');
}

// Lower-case, and let a hyphen or any run of whitespace stand for one space, so "Full-page" and
// "full\npage" count as "full page".
const normalise = (s) => s.toLowerCase().replace(/[-‐-―\s]+/g, ' ');
const count = (haystack, needle) => haystack.split(needle).length - 1;

const problems = [];
const name = block('Name').trim();
const summary = block('Summary').trim();
const description = normalise(block('Description'));

if (name !== en.extName.message) problems.push(`Name block is "${name}", extName is "${en.extName.message}"`);
if (summary !== en.extDescription.message)
  problems.push('Summary block differs from extDescription in extension/_locales/en/messages.json');
const summaryLength = Array.from(summary).length;
if (summaryLength > SUMMARY_LIMIT)
  problems.push(`Summary is ${summaryLength} characters (limit ${SUMMARY_LIMIT})`);

console.log(`summary: ${summaryLength} of ${SUMMARY_LIMIT} characters`);
for (const phrase of PHRASES) {
  const n = count(description, phrase);
  console.log(`${String(n).padStart(3)}  "${phrase}"`);
  if (n > REPEAT_LIMIT)
    problems.push(`"${phrase}" appears ${n} times in the description (limit ${REPEAT_LIMIT})`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nOK: listing matches the manifest strings and repeats no phrase more than five times.');
