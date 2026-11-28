/**
 * Zero-dependency APCA 0.0.98G-4g-base-W3 perceptual contrast and WCAG 2.2
 * relative luminance / contrast ratio helpers.
 */

export type RgbTuple = readonly [number, number, number];

// Published APCA 0.0.98G-4g-base-W3 constants
const MAIN_TRC = 2.4;
const S_R_CO = 0.2126729;
const S_G_CO = 0.7151522;
const S_B_CO = 0.072175;
const NORM_BG = 0.56;
const NORM_TXT = 0.57;
const REV_TXT = 0.62;
const REV_BG = 0.65;
const BLK_THRS = 0.022;
const BLK_CLMP = 1.414;
const SCALE_BOW = 1.14;
const SCALE_WOB = 1.14;
const LO_BOW_OFFSET = 0.027;
const LO_WOB_OFFSET = 0.027;
const LO_CLIP = 0.1;
const DELTA_Y_MIN = 0.0005;

export function parseCssRgbTuple(raw: string | undefined | null): RgbTuple | null {
  const value = String(raw ?? '').trim();
  const rgbMatch = value.match(/^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})(?:[\s,/]+[\d.]+)?\s*\)$/i);
  if (rgbMatch) {
    return [
      Math.max(0, Math.min(255, Number(rgbMatch[1]))),
      Math.max(0, Math.min(255, Number(rgbMatch[2]))),
      Math.max(0, Math.min(255, Number(rgbMatch[3]))),
    ];
  }
  const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return [
        Number.parseInt(hex[0] + hex[0], 16),
        Number.parseInt(hex[1] + hex[1], 16),
        Number.parseInt(hex[2] + hex[2], 16),
      ];
    }
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }
  return null;
}

export function wcag2Luminance([r, g, b]: RgbTuple): number {
  const toLinear = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function calcWcag2Contrast(fg: RgbTuple, bg: RgbTuple): number {
  const l1 = wcag2Luminance(fg);
  const l2 = wcag2Luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function srgbToApcaY([r, g, b]: RgbTuple): number {
  const lin = (c: number): number => (Math.max(0, Math.min(255, c)) / 255) ** MAIN_TRC;
  return S_R_CO * lin(r) + S_G_CO * lin(g) + S_B_CO * lin(b);
}

/**
 * Computes signed APCA Lightness Contrast (Lc) using 0.0.98G-4g-base-W3.
 * Positive values indicate dark text on light background; negative indicate light text on dark background.
 */
export function calcApcaLc(fg: RgbTuple, bg: RgbTuple): number {
  let txtY = srgbToApcaY(fg);
  let bgY = srgbToApcaY(bg);

  if (txtY < BLK_THRS) {
    txtY += (BLK_THRS - txtY) ** BLK_CLMP;
  }
  if (bgY < BLK_THRS) {
    bgY += (BLK_THRS - bgY) ** BLK_CLMP;
  }

  if (Math.abs(bgY - txtY) < DELTA_Y_MIN) {
    return 0;
  }

  let sapc = 0;
  let outputContrast = 0;

  if (bgY > txtY) {
    sapc = (bgY ** NORM_BG - txtY ** NORM_TXT) * SCALE_BOW;
    outputContrast = sapc < LO_CLIP ? 0 : sapc - LO_BOW_OFFSET;
  } else {
    sapc = (bgY ** REV_BG - txtY ** REV_TXT) * SCALE_WOB;
    outputContrast = sapc > -LO_CLIP ? 0 : sapc + LO_WOB_OFFSET;
  }

  return Number((outputContrast * 100).toFixed(2));
}
