// Shared settings model. Stored in chrome.storage.sync under the key "settings".

export const MARGIN_PRESETS = {
  none: 0,
  minimal: 5,
  default: 10,
  wide: 20,
};

export const LAYOUT_WIDTHS = [
  { id: 'auto', label: 'Fit to paper width' },
  { id: '1440', label: 'Desktop wide (1440 px)' },
  { id: '1280', label: 'Desktop (1280 px)' },
  { id: '1024', label: 'Laptop (1024 px)' },
  { id: '768', label: 'Tablet (768 px)' },
  { id: '375', label: 'Mobile (375 px)' },
];

export const DEFAULT_SETTINGS = {
  // Paper
  format: 'A4',
  orientation: 'portrait', // portrait | landscape
  marginPreset: 'default', // none | minimal | default | wide | custom
  margins: { top: 10, right: 10, bottom: 10, left: 10 }, // millimetres, used when marginPreset === 'custom'
  scale: 1, // 0.1 – 2
  layoutWidth: 'auto', // 'auto' or a CSS px width as string; overrides scale when set

  // Layout
  layout: 'paged', // paged | single
  pageRanges: '', // e.g. "1-3, 5"
  preferCssPageSize: false,

  // Content
  printBackground: true,
  mediaView: 'print', // print | screen
  hideFixed: true,
  loadLazy: true,
  expandScroll: true,
  outline: true,

  // Header / footer
  headerFooter: false,
  hfTitle: true,
  hfUrl: true,
  hfDate: true,
  hfPageNumbers: true,

  // Output
  output: 'download', // download | open
  filenameTemplate: '{title}',
  saveAs: false,

  // Image export (used by the element picker preview)
  imageFormat: 'png', // png | jpeg
  imageScale: 2, // device pixel ratio for captured images: 1 | 2 | 3

  // Appearance
  theme: 'system', // system | light | dark
  language: 'auto', // 'auto' (browser locale) or a locale code such as 'en', 'es', 'de'
};

export async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return normalizeSettings(stored.settings);
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings: normalizeSettings(settings) });
}

export function normalizeSettings(partial) {
  const s = { ...DEFAULT_SETTINGS, ...(partial || {}) };
  s.margins = { ...DEFAULT_SETTINGS.margins, ...((partial && partial.margins) || {}) };
  s.scale = clamp(Number(s.scale) || 1, 0.1, 2);
  return s;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
