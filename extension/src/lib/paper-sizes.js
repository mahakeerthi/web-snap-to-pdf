// Paper formats in inches (portrait). Matches the list Chrome's print engine accepts
// via Page.printToPDF paperWidth/paperHeight.
export const PAPER_SIZES = [
  { id: 'A0', label: 'A0 (841 × 1189 mm)', width: 33.11, height: 46.81 },
  { id: 'A1', label: 'A1 (594 × 841 mm)', width: 23.39, height: 33.11 },
  { id: 'A2', label: 'A2 (420 × 594 mm)', width: 16.54, height: 23.39 },
  { id: 'A3', label: 'A3 (297 × 420 mm)', width: 11.69, height: 16.54 },
  { id: 'A4', label: 'A4 (210 × 297 mm)', width: 8.27, height: 11.69 },
  { id: 'A5', label: 'A5 (148 × 210 mm)', width: 5.83, height: 8.27 },
  { id: 'A6', label: 'A6 (105 × 148 mm)', width: 4.13, height: 5.83 },
  { id: 'A7', label: 'A7 (74 × 105 mm)', width: 2.91, height: 4.13 },
  { id: 'A8', label: 'A8 (52 × 74 mm)', width: 2.05, height: 2.91 },
  { id: 'A9', label: 'A9 (37 × 52 mm)', width: 1.46, height: 2.05 },
  { id: 'B0', label: 'B0 (1000 × 1414 mm)', width: 39.37, height: 55.67 },
  { id: 'B1', label: 'B1 (707 × 1000 mm)', width: 27.83, height: 39.37 },
  { id: 'B2', label: 'B2 (500 × 707 mm)', width: 19.69, height: 27.83 },
  { id: 'B3', label: 'B3 (353 × 500 mm)', width: 13.9, height: 19.69 },
  { id: 'B4', label: 'B4 (250 × 353 mm)', width: 9.84, height: 13.9 },
  { id: 'B5', label: 'B5 (176 × 250 mm)', width: 6.93, height: 9.84 },
  { id: 'Letter', label: 'Letter (8.5 × 11 in)', width: 8.5, height: 11 },
  { id: 'Legal', label: 'Legal (8.5 × 14 in)', width: 8.5, height: 14 },
  { id: 'Tabloid', label: 'Tabloid (11 × 17 in)', width: 11, height: 17 },
  { id: 'Ledger', label: 'Ledger (17 × 11 in)', width: 17, height: 11 },
  { id: 'Folio', label: 'Folio (8.5 × 13 in)', width: 8.5, height: 13 },
  { id: 'Executive', label: 'Executive (7.25 × 10.5 in)', width: 7.25, height: 10.5 },
];

export function getPaperSize(id) {
  return PAPER_SIZES.find((p) => p.id === id) || PAPER_SIZES.find((p) => p.id === 'A4');
}

// Largest page dimension most PDF viewers accept (200 in = 14400 pt).
export const MAX_PAGE_INCHES = 200;
export const CSS_PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;
