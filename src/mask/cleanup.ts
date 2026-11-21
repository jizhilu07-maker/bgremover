/**
 * Visit connected components of pixels where `inSet(i)` is true.
 * `onComponent` gets the pixel indices (a view into a shared buffer, valid only during the call)
 * and whether the component touches the image border.
 */
function forEachComponent(
  w: number,
  h: number,
  inSet: (i: number) => boolean,
  eightConnected: boolean,
  onComponent: (pixels: Int32Array, touchesBorder: boolean) => void,
): void {
  const n = w * h;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start] || !inSet(start)) continue;
    let head = 0, tail = 0, border = false;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dy === 0) || (!eightConnected && dx !== 0 && dy !== 0)) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!seen[j] && inSet(j)) { seen[j] = 1; queue[tail++] = j; }
        }
      }
    }
    onComponent(queue.subarray(0, tail), border);
  }
}

/** Remove foreground specks smaller than `minArea` pixels (leftover background bits). */
export function removeIslands(alpha: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  const out = alpha.slice();
  // Low threshold so the faint fringe of a speck goes with it instead of leaving a ghost.
  forEachComponent(w, h, (i) => alpha[i] > 16, true, (px) => {
    if (px.length < minArea) for (const i of px) out[i] = 0;
  });
  return out;
}

/** Fill enclosed transparent holes smaller than `minArea` pixels. Regions open to the border are real background. */
export function fillHoles(alpha: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  const out = alpha.slice();
  forEachComponent(w, h, (i) => alpha[i] < 240, false, (px, touchesBorder) => {
    if (!touchesBorder && px.length < minArea) for (const i of px) out[i] = 255;
  });
  return out;
}
