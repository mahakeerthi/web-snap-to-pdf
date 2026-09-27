// Colour theme for extension pages (popup, options, viewer).
//
// settings.theme is 'system' | 'light' | 'dark'. 'light' / 'dark' set data-theme on <html>;
// 'system' removes it so the CSS falls back to prefers-color-scheme.
//
// Avoiding a flash of the wrong theme: chrome.storage is async, so pages mark <html data-boot>
// and hide the body with `html[data-boot] body { visibility: hidden }` (visibility, not display,
// so Chrome still sizes the popup correctly). Importing this module applies the last theme
// synchronously from a localStorage cache, then confirms it from chrome.storage.sync. The page
// calls reveal() once it is ready; a short timeout reveals it anyway.

const THEMES = ['system', 'light', 'dark'];
const CACHE_KEY = 'pagesnap-theme';
const REVEAL_TIMEOUT_MS = 400;

export function normalizeTheme(theme) {
  return THEMES.includes(theme) ? theme : 'system';
}

/** Apply a theme to the document now and remember it for the next page load. */
export function applyTheme(theme) {
  const t = normalizeTheme(theme);
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  try {
    localStorage.setItem(CACHE_KEY, t);
  } catch {
    // Storage can be unavailable (e.g. blocked); the cache is only an optimisation.
  }
  return t;
}

/** The theme after `theme` in the toggle cycle system → light → dark → system. */
export function nextTheme(theme) {
  const t = normalizeTheme(theme);
  return THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
}

let initPromise = null;

/** Read settings.theme from chrome.storage.sync, apply it and keep following changes. */
export function initTheme() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let theme = 'system';
    try {
      const { settings } = await chrome.storage.sync.get('settings');
      theme = normalizeTheme(settings && settings.theme);
    } catch {
      // Keep the cached / system theme.
    }
    applyTheme(theme);
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.settings)
          applyTheme(changes.settings.newValue && changes.settings.newValue.theme);
      });
    } catch {
      // Not running as an extension page.
    }
    return theme;
  })();
  return initPromise;
}

/** Show the page (removes the data-boot guard). Safe to call more than once. */
export function reveal() {
  document.documentElement.removeAttribute('data-boot');
}

// --- runs on import, before the importing page's own code ---------------------------------
try {
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) applyTheme(cached);
} catch {
  // ignore
}
setTimeout(reveal, REVEAL_TIMEOUT_MS);
initTheme();
