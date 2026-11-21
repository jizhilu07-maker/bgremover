export type RGB = [number, number, number];

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
}

export function rgbToLab(r: number, g: number, b: number): RGB {
  const R = SRGB_TO_LINEAR[r], G = SRGB_TO_LINEAR[g], B = SRGB_TO_LINEAR[b];
  const fx = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const fy = labF(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const fz = labF((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE from every pixel to `target`. Lab is used because RGB distance does not match perceived difference. */
export function distanceMap(rgba: ArrayLike<number>, target: RGB): Float32Array {
  const n = rgba.length >> 2;
  const out = new Float32Array(n);
  const [tl, ta, tb] = rgbToLab(target[0], target[1], target[2]);
  for (let i = 0; i < n; i++) {
    const [l, a, b] = rgbToLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    out[i] = Math.hypot(l - tl, a - ta, b - tb);
  }
  return out;
}

/** Average colour of the 3x3 block around (x, y); one JPEG-noisy pixel is a poor sample. */
export function sampleColor(rgba: ArrayLike<number>, w: number, h: number, x: number, y: number): RGB {
  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
    for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
      const i = (yy * w + xx) * 4;
      r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * Select pixels whose colour is within `tolerance` of `target`.
 * `seeds` given → only regions 4-connected to a seed (flood fill); null → the whole image.
 *
 * Returns 0..255 coverage. Pixels just outside the selection get partial coverage by
 * unmixing: a pixel halfway (in ΔE) between the target and the nearest clearly-different
 * colour is treated as a 50% blend. A hard threshold here is what leaves halos or eats
 * anti-aliased edges.
 */
export function selectByColor(
  rgba: ArrayLike<number>,
  w: number,
  h: number,
  target: RGB,
  tolerance: number,
  seeds: number[] | null,
): Uint8Array {
  const n = w * h;
  const d = distanceMap(rgba, target);
  const core = new Uint8Array(n);

  if (seeds === null) {
    for (let i = 0; i < n; i++) if (d[i] <= tolerance) core[i] = 1;
  } else {
    // 4-connectivity: 8-connectivity leaks through one-pixel diagonal gaps between strokes.
    const stack = new Int32Array(n);
    let top = 0;
    for (const s of seeds) {
      if (s >= 0 && s < n && !core[s] && d[s] <= tolerance) { core[s] = 1; stack[top++] = s; }
    }
    while (top > 0) {
      const i = stack[--top];
      const x = i % w;
      const push = (j: number) => {
        if (!core[j] && d[j] <= tolerance) { core[j] = 1; stack[top++] = j; }
      };
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < n - w) push(i + w);
    }
  }

  const sel = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (core[i]) sel[i] = 255;

  // Anti-aliasing ramps can be ~2px wide, so look at a 2px band around the core.
  const band = dilate3x3(dilate3x3(core, w, h), w, h);
  const R = 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (core[i] || !band[i]) continue;
      let dMax = d[i];
      for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) {
        for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) {
          const v = d[yy * w + xx];
          if (v > dMax) dMax = v;
        }
      }
      if (dMax <= d[i]) continue;
      const fg = (d[i] - tolerance) / (dMax - tolerance);
      sel[i] = Math.round(255 * (1 - Math.min(1, Math.max(0, fg))));
    }
  }
  return sel;
}

function dilate3x3(src: Uint8Array, w: number, h: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      tmp[i] = src[i] | (x > 0 ? src[i - 1] : 0) | (x < w - 1 ? src[i + 1] : 0);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] = tmp[i] | (y > 0 ? tmp[i - w] : 0) | (y < h - 1 ? tmp[i + w] : 0);
    }
  }
  return out;
}
