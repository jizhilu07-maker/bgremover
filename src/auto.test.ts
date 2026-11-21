import { describe, expect, it } from 'vitest';
import { analyzeBorder, isSolidBackground, removeSolidBackground } from './auto';

function img(w: number, h: number, fn: (x: number, y: number) => number[]) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...fn(x, y), 255], (y * w + x) * 4);
  return d;
}

describe('auto background', () => {
  it('detects a solid background and removes it, keeping the subject', () => {
    const w = 20, h = 20;
    const d = img(w, h, (x, y) => (x >= 5 && x < 15 && y >= 5 && y < 15 ? [200, 30, 30] : [250, 250, 250]));
    const a = analyzeBorder(d, w, h);
    expect(isSolidBackground(a)).toBe(true);
    expect(a.color).toEqual([250, 250, 250]);
    const alpha = removeSolidBackground(d, w, h, a);
    expect(alpha[0]).toBe(0);
    expect(alpha[10 * w + 10]).toBe(255);
  });

  it('keeps background-coloured areas enclosed by the subject (inside a ring)', () => {
    const w = 21, h = 21;
    const d = img(w, h, (x, y) => {
      const r = Math.hypot(x - 10, y - 10);
      return r >= 4 && r <= 7 ? [0, 0, 0] : [255, 255, 255];
    });
    const alpha = removeSolidBackground(d, w, h, analyzeBorder(d, w, h));
    expect(alpha[0]).toBe(0);
    expect(alpha[10 * w + 10]).toBe(255);
  });

  it('keeps a light-grey subject area that is close to a pure white background', () => {
    const w = 20, h = 20;
    const d = img(w, h, (x, y) => (x >= 5 && x < 15 && y >= 5 && y < 15 ? [242, 242, 242] : [255, 255, 255]));
    const alpha = removeSolidBackground(d, w, h, analyzeBorder(d, w, h));
    expect(alpha[0]).toBe(0);
    expect(alpha[10 * w + 10]).toBe(255);
  });

  it('treats a noisy photo border as not solid', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 255;
    const w = 30, h = 30;
    const d = img(w, h, () => [rnd(), rnd(), rnd()]);
    expect(isSolidBackground(analyzeBorder(d, w, h))).toBe(false);
  });
});
