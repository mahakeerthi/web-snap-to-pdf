// Translates user settings into Page.printToPDF parameters.
import { getPaperSize, CSS_PX_PER_INCH, MM_PER_INCH } from './paper-sizes.js';
import { MARGIN_PRESETS, clamp } from './settings.js';

const HF_MIN_MARGIN_IN = 0.5;

export function marginsInches(settings) {
  if (settings.marginPreset === 'custom') {
    const m = settings.margins;
    return {
      top: mm(m.top),
      right: mm(m.right),
      bottom: mm(m.bottom),
      left: mm(m.left),
    };
  }
  const v = mm(MARGIN_PRESETS[settings.marginPreset] ?? MARGIN_PRESETS.default);
  return { top: v, right: v, bottom: v, left: v };
}

function mm(v) {
  return Math.max(0, Number(v) || 0) / MM_PER_INCH;
}

// Oriented paper size in inches, i.e. already swapped for landscape.
export function orientedPaper(settings) {
  const size = getPaperSize(settings.format);
  const landscape = settings.orientation === 'landscape';
  return landscape ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
}

export function effectiveScale(settings, paper, margins) {
  let scale = clamp(Number(settings.scale) || 1, 0.1, 2);
  if (settings.layoutWidth && settings.layoutWidth !== 'auto') {
    const targetPx = Number(settings.layoutWidth);
    const printableIn = paper.width - margins.left - margins.right;
    if (targetPx > 0 && printableIn > 0) {
      scale = clamp((printableIn * CSS_PX_PER_INCH) / targetPx, 0.1, 2);
    }
  }
  return scale;
}

// CSS pixel width the page will be laid out at before scaling.
export function layoutWidthPx(paper, margins, scale) {
  const printableIn = paper.width - margins.left - margins.right;
  return Math.max(200, Math.round((printableIn * CSS_PX_PER_INCH) / scale));
}

export function buildHeaderFooter(settings) {
  if (!settings.headerFooter) return {};
  const base =
    'font-family: Helvetica, Arial, sans-serif; font-size: 8px; color: #666; width: 100%;' +
    'padding: 0 0.4in; display: flex; justify-content: space-between; align-items: center; gap: 12px;';
  const ellipsis = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
  const header = [];
  if (settings.hfTitle) header.push(`<span class="title" style="${ellipsis} max-width: 70%"></span>`);
  if (settings.hfDate) header.push('<span class="date" style="flex-shrink: 0"></span>');
  const footer = [];
  if (settings.hfUrl) footer.push(`<span class="url" style="${ellipsis} max-width: 75%"></span>`);
  if (settings.hfPageNumbers) {
    footer.push(
      '<span style="flex-shrink: 0"><span class="pageNumber"></span> / <span class="totalPages"></span></span>',
    );
  }
  const wrap = (parts) => (parts.length ? `<div style="${base}">${parts.join('')}</div>` : '<span></span>');
  return {
    displayHeaderFooter: true,
    headerTemplate: wrap(header),
    footerTemplate: wrap(footer),
  };
}

// Returns { params, paper, margins, scale }. `params` is the object passed to Page.printToPDF
// for the paged layout. Single-page mode adjusts paperHeight afterwards.
export function buildPrintParams(settings) {
  const paper = orientedPaper(settings);
  const margins = marginsInches(settings);
  if (settings.headerFooter) {
    margins.top = Math.max(margins.top, HF_MIN_MARGIN_IN);
    margins.bottom = Math.max(margins.bottom, HF_MIN_MARGIN_IN);
  }
  const scale = effectiveScale(settings, paper, margins);

  const params = {
    // We pass the already-oriented size and keep landscape=false so the numbers are exact.
    landscape: false,
    paperWidth: paper.width,
    paperHeight: paper.height,
    marginTop: margins.top,
    marginRight: margins.right,
    marginBottom: margins.bottom,
    marginLeft: margins.left,
    scale,
    printBackground: !!settings.printBackground,
    preferCSSPageSize: !!settings.preferCssPageSize,
    generateDocumentOutline: !!settings.outline,
    transferMode: 'ReturnAsBase64',
    ...buildHeaderFooter(settings),
  };
  const ranges = String(settings.pageRanges || '').replace(/\s+/g, '');
  if (ranges && settings.layout !== 'single') params.pageRanges = ranges;
  return { params, paper, margins, scale };
}

// `ext` defaults to 'pdf' so existing callers are unchanged; image / Markdown exports pass their own.
export function buildFilename(template, meta, ext = 'pdf') {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const vars = {
    title: meta.title || 'page',
    domain: meta.domain || 'site',
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}-${pad(date.getMinutes())}`,
  };
  let name = String(template || '{title}').replace(/\{(title|domain|date|time)\}/g, (_, k) => vars[k]);
  name = sanitizeFilename(name);
  if (!name) name = 'page';
  const suffix =
    String(ext || 'pdf')
      .replace(/^\.+/, '')
      .replace(/[^a-z0-9]/gi, '') || 'pdf';
  return `${name}.${suffix}`;
}

export function sanitizeFilename(name) {
  return (
    String(name)
      // eslint-disable-next-line no-control-regex -- strip C0 control characters from filenames
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 150)
      .trim()
  );
}
