import { describe, expect, it } from 'vitest';
import { Editor } from './Editor';

const make = (w = 10, h = 10) => new Editor(new Uint8ClampedArray(w * h * 4), w, h);

describe('Editor', () => {
  it('undo/redo restore the exact mask', () => {
    const ed = make();
    const next = ed.alpha.slice();
    next[55] = 0;
    next[12] = 7;
    ed.commit(next);
    const after = ed.alpha.slice();
    ed.undo();
    expect(ed.alpha.every((v) => v === 255)).toBe(true);
    ed.redo();
    expect(ed.alpha).toEqual(after);
  });

  it('a brush stroke is one undo step', () => {
    const ed = make(40, 40);
    ed.beginStroke();
    ed.brush(5, 5, 30, 30, 3, false);
    ed.brush(30, 30, 35, 5, 3, false);
    ed.endStroke();
    expect(ed.alpha[20 * 40 + 20]).toBe(0);
    ed.undo();
    expect(ed.alpha.every((v) => v === 255)).toBe(true);
    expect(ed.canUndo).toBe(false);
  });

  it('applySelection removes or keeps', () => {
    const ed = make(2, 1);
    ed.applySelection(new Uint8Array([255, 0]), false);
    expect([...ed.alpha]).toEqual([0, 255]);
    // An isolated half-selected pixel (no unselected neighbours to judge by) gets exactly half.
    const one = make(1, 1);
    one.commit(new Uint8Array([0]));
    one.applySelection(new Uint8Array([128]), true);
    expect([...one.alpha]).toEqual([128]);
  });

  it('soft selections combine as probabilities, and can be applied onto a saved base', () => {
    const ed = make(1, 1);
    const base = ed.alpha.slice();
    ed.applySelection(new Uint8Array([128]), false);
    ed.applySelection(new Uint8Array([128]), false);
    expect(ed.alpha[0]).toBeLessThan(70); // ≈ 25%, not stuck at 50%
    ed.applySelection(new Uint8Array([255]), false, base);
    expect(ed.alpha[0]).toBe(0);
  });

  it('removing two adjacent regions one after another leaves no seam', () => {
    // [region A | blended seam pixel | region B], both removed in turn.
    const ed = make(3, 1);
    ed.applySelection(new Uint8Array([255, 128, 0]), false);
    expect([...ed.alpha]).toEqual([0, 127, 255]); // B still opaque, so the seam keeps B's share
    ed.applySelection(new Uint8Array([0, 128, 255]), false);
    expect([...ed.alpha]).toEqual([0, 0, 0]);
  });

  it('keeping a region next to opaque foreground fills the seam completely', () => {
    const ed = make(3, 1);
    ed.commit(new Uint8Array([0, 0, 255]));
    ed.applySelection(new Uint8Array([255, 128, 0]), true);
    expect([...ed.alpha]).toEqual([255, 255, 255]);
  });

  it('version changes with every mask change, including undo', () => {
    const ed = make(1, 1);
    const v0 = ed.version;
    ed.applySelection(new Uint8Array([255]), false);
    const v1 = ed.version;
    ed.undo();
    expect(v1).toBeGreaterThan(v0);
    expect(ed.version).toBeGreaterThan(v1);
  });

  it('a no-op change adds no history', () => {
    const ed = make();
    ed.commit(ed.alpha.slice());
    expect(ed.canUndo).toBe(false);
  });

  it('caps history at 50 steps', () => {
    const ed = make();
    for (let i = 0; i < 60; i++) {
      const n = ed.alpha.slice();
      n[i % 100] = i % 2 ? 1 : 2;
      ed.commit(n);
    }
    let steps = 0;
    while (ed.canUndo) { ed.undo(); steps++; }
    expect(steps).toBe(50);
  });
});
