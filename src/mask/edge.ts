import type { RGB } from './color';

/** One pixel of grey-scale erosion (shrink) or dilation (grow) with a 3x3 window. */
export function morph(alpha: Uint8Array, w: number, h: number, grow: boolean): Uint8Array {
  const pick = grow ? Math.max : Math.min;
  const tmp = new Uint8Array(alpha.length);
  const out = new Uint8Array(alpha.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      tmp[i] = pick(alpha[i], alpha[x > 0 ? i - 1 : i], alpha[x < w - 1 ? i + 1 : i]);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] = pick(tmp[i], tmp[y > 0 ? i - w : i], tmp[y < h - 1 ? i + w : i]);
    }
  }
  return out;
}

/** Mean over a (2r+1)² window, edges normalised by the in-bounds count. */
function boxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
      tmp[row + x] = sum / (hi - lo + 1);
      if (x + r + 1 < w) sum += src[row + x + r + 1];
      if (x - r >= 0) sum -= src[row + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) sum += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
      out[y * w + x] = sum / (hi - lo + 1);
      if (y + r + 1 < h) sum += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) sum -= tmp[(y - r) * w + x];
    }
  }
  return out;
}

export function resizeBilinear(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0] + (src[y0 * sw + x1] - src[y0 * sw + x0]) * tx;
      const b = src[y1 * sw + x0] + (src[y1 * sw + x1] - src[y1 * sw + x0]) * tx;
      out[y * dw + x] = a + (b - a) * ty;
    }
  }
  return out;
}

function grayAt(rgba: ArrayLike<number>, i: number): number {
  return (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
}

/** Area-average downsample of the luminance channel. */
function grayDownsample(rgba: ArrayLike<number>, w: number, h: number, dw: number, dh: number): Float32Array {
  const sum = new Float32Array(dw * dh);
  const cnt = new Uint32Array(dw * dh);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(dh - 1, Math.floor((y * dh) / h));
    for (let x = 0; x < w; x++) {
      const j = ty * dw + Math.min(dw - 1, Math.floor((x * dw) / w));
      sum[j] += grayAt(rgba, y * w + x);
      cnt[j]++;
    }
  }
  for (let j = 0; j < sum.length; j++) sum[j] /= cnt[j] || 1;
  return sum;
}

/**
 * Turn a low-resolution probability map into a full-resolution alpha whose edges follow the image.
 * Fast guided filter (He & Sun 2015): solve the linear coefficients at ≤1024px, upsample them, apply
 * at full resolution. A plain upscale of the mask would give soft, misplaced edges on 4K input;
 * a full-res guided filter would need ~200MB of float buffers.
 */
export function refineWithGuide(
  prob: Float32Array,
  pw: number,
  ph: number,
  rgba: ArrayLike<number>,
  w: number,
  h: number,
  r = 2,
  eps = 1e-3,
): Uint8Array {
  const s = Math.min(1, 1024 / Math.max(w, h));
  const lw = Math.max(1, Math.round(w * s)), lh = Math.max(1, Math.round(h * s));
  const p = resizeBilinear(prob, pw, ph, lw, lh);
  const I = grayDownsample(rgba, w, h, lw, lh);
  const n = lw * lh;
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxFilter(I, lw, lh, r), mP = boxFilter(p, lw, lh, r);
  const mIp = boxFilter(Ip, lw, lh, r), mII = boxFilter(II, lw, lh, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = (mIp[i] - mI[i] * mP[i]) / (mII[i] - mI[i] * mI[i] + eps);
    b[i] = mP[i] - a[i] * mI[i];
  }
  const A = resizeBilinear(boxFilter(a, lw, lh, r), lw, lh, w, h);
  const B = resizeBilinear(boxFilter(b, lw, lh, r), lw, lh, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(255 * Math.min(1, Math.max(0, A[i] * grayAt(rgba, i) + B[i])));
  }
  return out;
}

/** Area-average downsample of R, G, B into three planes. */
function colorDownsample(rgba: ArrayLike<number>, w: number, h: number, dw: number, dh: number): Float32Array[] {
  const planes = [new Float32Array(dw * dh), new Float32Array(dw * dh), new Float32Array(dw * dh)];
  const cnt = new Uint32Array(dw * dh);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(dh - 1, Math.floor((y * dh) / h));
    for (let x = 0; x < w; x++) {
      const j = ty * dw + Math.min(dw - 1, Math.floor((x * dw) / w));
      const i = (y * w + x) * 4;
      planes[0][j] += rgba[i]; planes[1][j] += rgba[i + 1]; planes[2][j] += rgba[i + 2];
      cnt[j]++;
    }
  }
  for (const p of planes) for (let j = 0; j < p.length; j++) p[j] /= cnt[j] || 1;
  return planes;
}

/** Bilinear lookup in a gw×gh grid at grid coordinates (gx, gy), clamped to the edges. */
function sampleGrid(g: Float32Array, gw: number, gh: number, gx: number, gy: number): number {
  const fx = Math.min(gw - 1, Math.max(0, gx)), fy = Math.min(gh - 1, Math.max(0, gy));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const a = g[y0 * gw + x0] + (g[y0 * gw + x1] - g[y0 * gw + x0]) * tx;
  const b = g[y1 * gw + x0] + (g[y1 * gw + x1] - g[y1 * gw + x0]) * tx;
  return a + (b - a) * ty;
}

/**
 * Snap a coarse selection (e.g. SAM, whose boundary is only accurate to a few pixels) onto the real
 * colour edge. Within a band around the coarse boundary every pixel is unmixed against the local
 * mean colours of the sure-inside (F) and sure-outside (B) regions: α = (C−B)·(F−B) / |F−B|².
 * The guided filter cannot do this: inside a flat-coloured area it has no edge to pull towards.
 * Local means are computed at ≤1024px and sampled bilinearly, so 4K input stays cheap.
 */
export function snapToColors(
  prob: Float32Array,
  pw: number,
  ph: number,
  rgba: ArrayLike<number>,
  w: number,
  h: number,
): Uint8Array {
  const s = Math.min(1, 1024 / Math.max(w, h));
  const lw = Math.max(1, Math.round(w * s)), lh = Math.max(1, Math.round(h * s));
  const n = lw * lh;
  const p = resizeBilinear(prob, pw, ph, lw, lh);
  const hard = new Float32Array(n);
  for (let i = 0; i < n; i++) hard[i] = p[i] >= 0.5 ? 1 : 0;

  // Band half-width ≈ 6px at 1024px, covering SAM's low-res boundary error.
  const d = Math.max(3, Math.round((6 * Math.max(lw, lh)) / 1024));
  const frac = boxFilter(hard, lw, lh, d);
  const fgW = new Float32Array(n), bgW = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (frac[i] > 0.999) fgW[i] = 1;
    else if (frac[i] < 0.001) bgW[i] = 1;
  }
  const C = colorDownsample(rgba, w, h, lw, lh);
  const R = 2 * d;
  const fgN = boxFilter(fgW, lw, lh, R), bgN = boxFilter(bgW, lw, lh, R);
  const fgC = C.map((c) => boxFilter(c.map((v, i) => v * fgW[i]), lw, lh, R));
  const bgC = C.map((c) => boxFilter(c.map((v, i) => v * bgW[i]), lw, lh, R));

  const MIN_CONTRAST2 = 24 * 24;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = ((y + 0.5) * lh) / h - 0.5;
    for (let x = 0; x < w; x++) {
      const gx = ((x + 0.5) * lw) / w - 0.5;
      const inside = sampleGrid(p, lw, lh, gx, gy) >= 0.5;
      const i = y * w + x;
      out[i] = inside ? 255 : 0;
      const fr = sampleGrid(frac, lw, lh, gx, gy);
      if (fr <= 0.001 || fr >= 0.999) continue;
      const nf = sampleGrid(fgN, lw, lh, gx, gy), nb = sampleGrid(bgN, lw, lh, gx, gy);
      if (nf < 1e-3 || nb < 1e-3) continue;
      let dot = 0, len2 = 0;
      for (let c = 0; c < 3; c++) {
        const F = sampleGrid(fgC[c], lw, lh, gx, gy) / nf;
        const B = sampleGrid(bgC[c], lw, lh, gx, gy) / nb;
        dot += (rgba[i * 4 + c] - B) * (F - B);
        len2 += (F - B) * (F - B);
      }
      // Too little colour difference to tell inside from outside: keep the model's decision.
      if (len2 < MIN_CONTRAST2) continue;
      out[i] = Math.round(255 * Math.min(1, Math.max(0, dot / len2)));
    }
  }
  return out;
}

/**
 * Colour decontamination: semi-transparent edge pixels still carry the old background colour,
 * which shows as a halo on any new background. Returns RGBA with corrected RGB (A = 255).
 *
 * With a known solid background the true colour is solved exactly: F = (C − (1−α)·B) / α.
 * Otherwise (or where α is too small for that to be stable) F is propagated inward from the
 * nearest fully opaque pixels, ring by ring.
 */
export function decontaminate(
  rgba: ArrayLike<number>,
  alpha: Uint8Array,
  w: number,
  h: number,
  bg: RGB | null,
): Uint8ClampedArray {
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n * 4; i++) out[i] = (i & 3) === 3 ? 255 : rgba[i];

  const OPAQUE = 250;
  const known = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (alpha[i] >= OPAQUE) known[i] = 1;

  const isEdge = (i: number) => alpha[i] > 0 && alpha[i] < OPAQUE;
  const forNeighbours = (i: number, fn: (j: number) => void) => {
    const x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if ((dx || dy) && xx >= 0 && xx < w) fn(yy * w + xx);
      }
    }
  };

  let ring: number[] = [];
  const queued = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!isEdge(i)) continue;
    let touches = false;
    forNeighbours(i, (j) => { if (known[j]) touches = true; });
    if (touches) { ring.push(i); queued[i] = 1; }
  }
  while (ring.length) {
    const colours = new Float32Array(ring.length * 3);
    ring.forEach((i, k) => {
      let r = 0, g = 0, b = 0, c = 0;
      forNeighbours(i, (j) => {
        if (known[j]) { r += out[j * 4]; g += out[j * 4 + 1]; b += out[j * 4 + 2]; c++; }
      });
      colours[k * 3] = r / c; colours[k * 3 + 1] = g / c; colours[k * 3 + 2] = b / c;
    });
    const next: number[] = [];
    ring.forEach((i, k) => {
      for (let c = 0; c < 3; c++) out[i * 4 + c] = colours[k * 3 + c];
      known[i] = 1;
    });
    for (const i of ring) {
      forNeighbours(i, (j) => { if (!queued[j] && isEdge(j)) { queued[j] = 1; next.push(j); } });
    }
    ring = next;
  }

  if (bg) {
    for (let i = 0; i < n; i++) {
      const a = alpha[i] / 255;
      if (!isEdge(i) || a < 0.25) continue;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = (rgba[i * 4 + c] - (1 - a) * bg[c]) / a;
    }
  }
  return out;
}
