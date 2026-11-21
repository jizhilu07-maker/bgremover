import { describe, expect, it } from 'vitest';
import { decontaminate, morph, refineWithGuide, snapToColors } from './edge';

describe('edge', () => {
  it('shrinks and grows by one pixel', () => {
    const w = 7, h = 7;
    const a = new Uint8Array(w * h);
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) a[y * w + x] = 255;
    expect(morph(a, w, h, false).filter((v) => v === 255).length).toBe(1);
    expect(morph(a, w, h, true).filter((v) => v === 255).length).toBe(25);
  });

  it('guided refinement keeps a constant mask constant', () => {
    const w = 16, h = 16;
    const rgba = new Uint8ClampedArray(w * h * 4).map((_, i) => (i * 37) % 256);
    const out = refineWithGuide(new Float32Array(64).fill(1), 8, 8, rgba, w, h);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(254);
  });

  it('guided refinement sharpens a blurry mask towards the image edge', () => {
    const w = 32, h = 8;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = x < 16 ? 0 : 255;
      rgba.set([v, v, v, 255], (y * w + x) * 4);
    }
    const ramp = [0, 0, 0.2, 0.4, 0.6, 0.8, 1, 1];
    const prob = new Float32Array(16).map((_, i) => ramp[i % 8]);
    const out = refineWithGuide(prob, 8, 2, rgba, w, h);
    expect(out[4 * w + 10]).toBeLessThan(60);
    expect(out[4 * w + 21]).toBeGreaterThan(195);
  });

  it('snaps a selection whose boundary is a few pixels off onto the colour edge', () => {
    // Image edge at x=16 (modest contrast); coarse selection boundary at x=18. The band scales with
    // image size (≈6px at 1024), so on a 48px image it is 3px and covers a 2px error.
    const w = 48, h = 24;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      rgba.set(x < 16 ? [150, 120, 90, 255] : [200, 210, 220, 255], (y * w + x) * 4);
    }
    const prob = new Float32Array(w * h).map((_, i) => (i % w < 18 ? 0 : 1));
    const out = snapToColors(prob, w, h, rgba, w, h);
    const row = Array.from(out.subarray(12 * w, 13 * w));
    expect(row.slice(0, 16).every((v) => v === 0)).toBe(true);
    expect(row.slice(16).every((v) => v === 255)).toBe(true);
  });

  it('gives a blended edge pixel a fractional value when snapping', () => {
    const w = 48, h = 24;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = x < 16 ? 0 : x === 16 ? 128 : 255;
      rgba.set([v, v, v, 255], (y * w + x) * 4);
    }
    const prob = new Float32Array(w * h).map((_, i) => (i % w < 18 ? 0 : 1));
    const out = snapToColors(prob, w, h, rgba, w, h);
    expect(out[12 * w + 16]).toBeGreaterThan(100);
    expect(out[12 * w + 16]).toBeLessThan(155);
  });

  it('recovers the foreground colour against a known background', () => {
    // red opaque | 50% red over white | white transparent
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 255, 128, 128, 255, 255, 255, 255, 255]);
    const out = decontaminate(rgba, new Uint8Array([255, 128, 0]), 3, 1, [255, 255, 255]);
    expect(out[4]).toBeGreaterThan(250);
    expect(out[5]).toBeLessThan(5);
    expect(out[6]).toBeLessThan(5);
  });

  it('propagates opaque colour into the edge when the background is unknown', () => {
    const rgba = new Uint8ClampedArray([0, 0, 255, 255, 120, 120, 200, 255]);
    const out = decontaminate(rgba, new Uint8Array([255, 100]), 2, 1, null);
    expect([out[4], out[5], out[6]]).toEqual([0, 0, 255]);
  });
});
