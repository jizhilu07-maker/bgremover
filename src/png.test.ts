import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePng } from './png';

describe('encodePng', () => {
  it('round-trips straight RGBA exactly, including colour under low alpha', async () => {
    const w = 5, h = 3;
    const rgba = new Uint8Array(w * h * 4).map((_, i) => (i * 53 + 7) % 256);
    rgba[3] = 1; // near-transparent pixel: its RGB must survive
    const png = await encodePng(rgba, w, h);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(w);
    expect(view.getUint32(20)).toBe(h);
    // 8-byte signature + 25-byte IHDR chunk, then IDAT length/type.
    const idatLen = view.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    const stride = w * 4;
    const decoded = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      expect(raw[y * (stride + 1)]).toBe(1);
      for (let x = 0; x < stride; x++) {
        const left = x >= 4 ? decoded[y * stride + x - 4] : 0;
        decoded[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + left) & 0xff;
      }
    }
    expect(decoded).toEqual(rgba);
  });
});
