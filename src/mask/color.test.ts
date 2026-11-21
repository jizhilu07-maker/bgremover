import { describe, expect, it } from 'vitest';
import { selectByColor, type RGB } from './color';

function image(w: number, h: number, px: (x: number, y: number) => RGB): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...px(x, y), 255], (y * w + x) * 4);
  return d;
}

describe('selectByColor', () => {
  // 9x5: white | black wall at x=4 | white
  const W = 9, H = 5;
  const img = image(W, H, (x) => (x === 4 ? [0, 0, 0] : [255, 255, 255]));

  it('contiguous fill stops at a different colour', () => {
    const sel = selectByColor(img, W, H, [255, 255, 255], 10, [0]);
    expect(sel[0]).toBe(255);
    expect(sel[3]).toBe(255);
    expect(sel[4]).toBe(0);
    expect(sel[8]).toBe(0);
  });

  it('global mode selects every matching pixel', () => {
    const sel = selectByColor(img, W, H, [255, 255, 255], 10, null);
    expect(sel[0]).toBe(255);
    expect(sel[8]).toBe(255);
    expect(sel[4]).toBe(0);
  });

  it('gives an anti-aliased edge pixel partial coverage', () => {
    // white, white, grey (≈50% blend), black…
    const w = 6;
    const edge = image(w, 1, (x) => (x < 2 ? [255, 255, 255] : x === 2 ? [128, 128, 128] : [0, 0, 0]));
    const sel = selectByColor(edge, w, 1, [255, 255, 255], 5, [0]);
    expect(sel[1]).toBe(255);
    expect(sel[2]).toBeGreaterThan(40);
    expect(sel[2]).toBeLessThan(215);
    expect(sel[3]).toBe(0);
  });

  it('does not eat a flat region whose colour is merely close to the target', () => {
    const w = 8;
    const img2 = image(w, 1, (x) => (x < 3 ? [255, 255, 255] : [235, 235, 235]));
    const sel = selectByColor(img2, w, 1, [255, 255, 255], 3, [0]);
    for (let x = 3; x < w; x++) expect(sel[x]).toBe(0);
  });
});
