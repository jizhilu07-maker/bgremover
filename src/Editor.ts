import type { RGB } from './mask/color';
import { decontaminate } from './mask/edge';

export interface Rect { x: number; y: number; w: number; h: number }

interface Step { rect: Rect; before: Uint8Array; after: Uint8Array }

/** `historyChanged` is false for live brush updates, so the UI can skip re-rendering on every mouse move. */
type Listener = (dirty: Rect | null, historyChanged: boolean) => void;

const MAX_STEPS = 50;

/**
 * Source image + alpha mask + undo history. Every tool only ever changes `alpha`.
 * Kept outside React state: a 4K mask is 8MB and brush strokes mutate it dozens of times a second.
 */
export class Editor {
  alpha: Uint8Array;
  /** RGB used for display and export: the source, or its decontaminated version. */
  fg: Uint8ClampedArray;
  /** Known solid background colour (from auto-detection); lets decontamination solve colours exactly. */
  bg: RGB | null = null;

  /** Bumped on every mask change, so callers can tell whether the mask moved on since they last looked. */
  version = 0;

  private decontam = false;
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private strokeBase: Uint8Array | null = null;
  private listeners = new Set<Listener>();

  readonly rgba: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(rgba: Uint8ClampedArray, width: number, height: number) {
    this.rgba = rgba;
    this.width = width;
    this.height = height;
    this.alpha = new Uint8Array(width * height).fill(255);
    this.fg = rgba;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get decontaminating() { return this.decontam; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Replace the whole mask as one undoable step. */
  commit(next: Uint8Array): void {
    const prev = this.alpha;
    this.alpha = next;
    this.record(prev);
  }

  /**
   * Merge a 0..255 selection into `base` (default: the current mask) as one step.
   *
   * A partially selected pixel is part selection, part whatever lies just outside the selection.
   * That other part takes the alpha of the nearby unselected pixels: when they are already
   * transparent (two background regions removed one after the other) the blended seam between
   * them goes too; next to the subject it keeps the subject's share. Treating the pixel on its own
   * (min/max, or even multiplying) leaves a visible 1px outline between adjacent selections.
   */
  applySelection(sel: Uint8Array, keep: boolean, base: Uint8Array = this.alpha): void {
    const { width: w, height: h } = this;
    const R = 2;
    const next = new Uint8Array(base.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, a = base[i], s = sel[i];
        if (s === 0) { next[i] = a; continue; }
        if (s === 255) { next[i] = keep ? 255 : 0; continue; }
        let outside = -1;
        for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) {
          for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) {
            const j = yy * w + xx;
            if (sel[j] === 0 && base[j] > outside) outside = base[j];
          }
        }
        if (outside < 0) outside = a;
        const t = s / 255;
        next[i] = keep
          ? Math.max(a, Math.round(255 * t + (1 - t) * outside))
          : Math.min(a, Math.round((1 - t) * outside));
      }
    }
    this.commit(next);
  }

  beginStroke(): void {
    this.strokeBase = this.alpha.slice();
  }

  /** Paint a round-capped segment of radius `r` (image pixels), 1px anti-aliased edge. */
  brush(x0: number, y0: number, x1: number, y1: number, r: number, keep: boolean): void {
    const { width: w, height: h } = this;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + r + 1));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + r + 1));
    if (minX > maxX || minY > maxY) return;
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const t = len2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
        const dist = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
        const cov = Math.min(1, Math.max(0, r + 0.5 - dist));
        if (cov <= 0) continue;
        const i = y * w + x, v = Math.round(cov * 255);
        this.alpha[i] = keep ? Math.max(this.alpha[i], v) : Math.min(this.alpha[i], 255 - v);
      }
    }
    this.emit({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, false);
  }

  endStroke(): void {
    if (!this.strokeBase) return;
    const base = this.strokeBase;
    this.strokeBase = null;
    this.record(base);
  }

  undo(): void {
    const step = this.undoStack.pop();
    if (!step) return;
    this.writePatch(step.rect, step.before);
    this.redoStack.push(step);
    this.changed(step.rect);
  }

  redo(): void {
    const step = this.redoStack.pop();
    if (!step) return;
    this.writePatch(step.rect, step.after);
    this.undoStack.push(step);
    this.changed(step.rect);
  }

  setDecontaminate(on: boolean): void {
    this.decontam = on;
    this.refreshFg();
    this.emit(null, true);
  }

  /** Straight (non-premultiplied) RGBA for export. */
  exportRgba(): Uint8Array {
    const out = new Uint8Array(this.alpha.length * 4);
    for (let i = 0; i < this.alpha.length; i++) {
      out[i * 4] = this.fg[i * 4];
      out[i * 4 + 1] = this.fg[i * 4 + 1];
      out[i * 4 + 2] = this.fg[i * 4 + 2];
      out[i * 4 + 3] = this.alpha[i];
    }
    return out;
  }

  /** Store only the bounding box of what changed, so 50 steps on a 4K image stay small. */
  private record(prev: Uint8Array): void {
    const { width: w, height: h } = this;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (prev[i] !== this.alpha[i]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      this.emit(null, true);
      return;
    }
    const rect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    this.undoStack.push({ rect, before: this.readPatch(rect, prev), after: this.readPatch(rect, this.alpha) });
    if (this.undoStack.length > MAX_STEPS) this.undoStack.shift();
    this.redoStack = [];
    this.changed(rect);
  }

  private readPatch(r: Rect, src: Uint8Array): Uint8Array {
    const out = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) {
      const s = (r.y + y) * this.width + r.x;
      out.set(src.subarray(s, s + r.w), y * r.w);
    }
    return out;
  }

  private writePatch(r: Rect, data: Uint8Array): void {
    for (let y = 0; y < r.h; y++) {
      this.alpha.set(data.subarray(y * r.w, (y + 1) * r.w), (r.y + y) * this.width + r.x);
    }
  }

  private changed(rect: Rect): void {
    if (this.decontam) {
      this.refreshFg();
      this.emit(null, true);
    } else {
      this.emit(rect, true);
    }
  }

  private refreshFg(): void {
    this.fg = this.decontam ? decontaminate(this.rgba, this.alpha, this.width, this.height, this.bg) : this.rgba;
  }

  private emit(dirty: Rect | null, historyChanged: boolean): void {
    this.version++;
    for (const fn of this.listeners) fn(dirty, historyChanged);
  }
}
