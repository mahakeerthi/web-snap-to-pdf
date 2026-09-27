// Runtime localisation. Chrome's chrome.i18n only follows the browser locale, but users can pick
// a language in the popup, so dictionaries are loaded from _locales/<code>/messages.json at runtime.
// Dictionaries use Chrome's format ({ key: { message, description } }) so the manifest can reuse them.

export const SUPPORTED_LANGUAGES = [
  { code: 'auto', label: 'Auto (browser language)' },
  { code: 'en', label: 'English' },
];

const cache = new Map();

export function resolveLanguage(language) {
  if (language && language !== 'auto') return language;
  const nav = (globalThis.navigator && navigator.language) || 'en';
  const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
  const full = nav.replace('-', '_');
  if (codes.includes(full)) return full;
  const short = nav.split(/[-_]/)[0];
  return codes.includes(short) ? short : 'en';
}

/** Returns a flat { key: string } map for the language, falling back to English. */
export async function getMessages(language = 'auto') {
  const code = resolveLanguage(language);
  if (cache.has(code)) return cache.get(code);
  const en = code === 'en' ? {} : await loadDictionary('en');
  const dict = { ...en, ...(await loadDictionary(code)) };
  cache.set(code, dict);
  return dict;
}

async function loadDictionary(code) {
  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${code}/messages.json`));
    if (!res.ok) return {};
    const raw = await res.json();
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v && v.message ? v.message : String(v)]));
  } catch {
    return {};
  }
}

/** Translate a key, with $1..$n substitutions. Unknown keys return the key itself. */
export function t(messages, key, subs = []) {
  let s = (messages && messages[key]) || key;
  subs.forEach((v, i) => {
    s = s.replace(new RegExp(`\\$${i + 1}`, 'g'), String(v));
  });
  return s;
}

/**
 * Apply translations to a DOM subtree. Elements carry data-i18n="key" (textContent),
 * data-i18n-title="key", data-i18n-placeholder="key" or data-i18n-aria-label="key".
 */
export function applyTranslations(root, messages) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(messages, el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(messages, el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(messages, el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(messages, el.dataset.i18nAriaLabel));
}
