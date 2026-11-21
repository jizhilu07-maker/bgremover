import { describe, expect, it } from 'vitest';
import { fillHoles, removeIslands } from './cleanup';

describe('cleanup', () => {
  const w = 20, h = 20;

  it('removes islands below the area threshold and keeps larger ones', () => {
    const a = new Uint8Array(w * h);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) a[y * w + x] = 255;
    a[1 * w + 1] = 255;
    a[1 * w + 2] = 255;
    const out = removeIslands(a, w, h, 10);
    expect(out[1 * w + 1]).toBe(0);
    expect(out[10 * w + 10]).toBe(255);
  });

  it('fills enclosed holes below the threshold but not the outside background', () => {
    const a = new Uint8Array(w * h);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) a[y * w + x] = 255;
    a[10 * w + 10] = 0;
    const out = fillHoles(a, w, h, 10);
    expect(out[10 * w + 10]).toBe(255);
    expect(out[0]).toBe(0);
  });

  it('leaves holes at or above the threshold alone', () => {
    const a = new Uint8Array(w * h);
    for (let y = 2; y < 18; y++) for (let x = 2; x < 18; x++) a[y * w + x] = 255;
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) a[y * w + x] = 0;
    expect(fillHoles(a, w, h, 16)[10 * w + 10]).toBe(0);
  });
});
