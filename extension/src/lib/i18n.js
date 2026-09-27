// Runtime localisation. Chrome's chrome.i18n only follows the browser locale, but users can pick
// a language in the popup, so dictionaries are loaded from _locales/<code>/messages.json at runtime.
// Dictionaries use Chrome's format ({ key: { message, description } }) so the manifest can reuse them.

export const SUPPORTED_LANGUAGES = [
  { code: 'auto', label: 'Auto (browser language)' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'pt_BR', label: 'Português (Brasil)' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ja', label: '日本語' },
  { code: 'zh_CN', label: '简体中文' },
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
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, v && v.message ? v.message : String(v)]),
    );
  } catch {
    return {};
  }
}

/** Translate a key, with $1..$n substitutions. Unknown keys return the key itself. */
export function t(messages, key, subs = []) {
  let s = (messages && messages[key]) || key;
  subs.forEach((v, i) => {
    s = s.replace(new RegExp(`\\$${i + 1}(?![0-9])`, 'g'), () => String(v)); // function: no $& patterns
  });
  return s;
}

/**
 * Apply translations to a DOM subtree. Elements carry data-i18n="key" (textContent),
 * data-i18n-title="key", data-i18n-placeholder="key" or data-i18n-aria-label="key".
 * Keys missing from the dictionary leave the element untouched, so the English text in the
 * HTML stays as the fallback if a dictionary cannot be loaded.
 */
export function applyTranslations(root, messages) {
  const has = (key) => !!(messages && Object.prototype.hasOwnProperty.call(messages, key) && messages[key]);
  const each = (attr, apply) => {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      const key = el.getAttribute(attr);
      if (has(key)) apply(el, messages[key]);
    }
  };
  each('data-i18n', (el, s) => (el.textContent = s));
  each('data-i18n-title', (el, s) => (el.title = s));
  each('data-i18n-placeholder', (el, s) => (el.placeholder = s));
  each('data-i18n-aria-label', (el, s) => el.setAttribute('aria-label', s));
}
