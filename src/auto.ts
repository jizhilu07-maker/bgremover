import { distanceMap, selectByColor, type RGB } from './mask/color';

export interface BorderAnalysis {
  color: RGB;
  tolerance: number;
  /** Share of border pixels within ΔE 4 of the median colour. */
  uniformity: number;
}

/** Graphics (logos, screenshots, stamps) have near-identical border pixels; photos have noise and gradients. */
const SOLID_UNIFORMITY = 0.9;

function borderIndices(w: number, h: number): number[] {
  const idx: number[] = [];
  for (let x = 0; x < w; x++) idx.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) idx.push(y * w, y * w + w - 1);
  return idx;
}

function gather(rgba: ArrayLike<number>, idx: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(idx.length * 4);
  idx.forEach((p, k) => {
    for (let c = 0; c < 3; c++) out[k * 4 + c] = rgba[p * 4 + c];
  });
  return out;
}

export function analyzeBorder(rgba: ArrayLike<number>, w: number, h: number): BorderAnalysis {
  const idx = borderIndices(w, h);
  const border = gather(rgba, idx);
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let k = 0; k < idx.length; k++) for (let c = 0; c < 3; c++) hist[c][border[k * 4 + c]]++;
  const median = (hc: Uint32Array) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hc[v]) * 2 >= idx.length) return v;
    return 255;
  };
  const color: RGB = [median(hist[0]), median(hist[1]), median(hist[2])];
  const d = Array.from(distanceMap(border, color)).sort((a, b) => a - b);
  const uniformity = d.filter((v) => v <= 4).length / d.length;
  const p90 = d[Math.floor(d.length * 0.9)];
  // Kept tight: anti-aliased edges are handled by the unmixing band in selectByColor, so a wide
  // tolerance only buys eaten near-white subject areas.
  const tolerance = Math.max(3, Math.min(25, p90 * 2 + 3));
  return { color, tolerance, uniformity };
}

export function isSolidBackground(a: BorderAnalysis): boolean {
  return a.uniformity >= SOLID_UNIFORMITY;
}

/** Alpha with the background colour removed, flood-filled inward from every matching border pixel. */
export function removeSolidBackground(
  rgba: ArrayLike<number>,
  w: number,
  h: number,
  bg: BorderAnalysis,
): Uint8Array {
  const idx = borderIndices(w, h);
  const d = distanceMap(gather(rgba, idx), bg.color);
  const seeds = idx.filter((_, k) => d[k] <= bg.tolerance);
  const sel = selectByColor(rgba, w, h, bg.color, bg.tolerance, seeds);
  for (let i = 0; i < sel.length; i++) sel[i] = 255 - sel[i];
  return sel;
}
