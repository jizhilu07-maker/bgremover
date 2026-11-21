import { useEffect, useRef } from 'react';
import type { Editor, Rect } from './Editor';

export type Tool = 'color' | 'sam' | 'brush';
export type PreviewBg = 'checker' | 'white' | 'black' | 'magenta';

interface Props {
  editor: Editor;
  tool: Tool;
  keep: boolean;
  brushSize: number;
  previewBg: PreviewBg;
  /** `exclude`: right click (SAM exclusion point). */
  onPick(x: number, y: number, exclude: boolean): void;
}

const BG_COLORS: Record<Exclude<PreviewBg, 'checker'>, string> = {
  white: '#ffffff',
  black: '#000000',
  magenta: '#ff00ff',
};

function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#cccccc';
  g.fillRect(0, 0, 8, 8);
  g.fillRect(8, 8, 8, 8);
  return ctx.createPattern(c, 'repeat')!;
}

export function Viewport(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Event handlers are bound once per editor; they read the latest props from here.
  const propsRef = useRef(props);
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    propsRef.current = props;
    drawRef.current();
  });

  const { editor } = props;

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const { width: w, height: h } = editor;

    const comp = document.createElement('canvas');
    comp.width = w;
    comp.height = h;
    const compCtx = comp.getContext('2d')!;
    const img = compCtx.createImageData(w, h);

    const updateComp = (r: Rect | null) => {
      const rect = r ?? { x: 0, y: 0, w, h };
      const { fg, alpha } = editor;
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const i = y * w + x;
          img.data[i * 4] = fg[i * 4];
          img.data[i * 4 + 1] = fg[i * 4 + 1];
          img.data[i * 4 + 2] = fg[i * 4 + 2];
          img.data[i * 4 + 3] = alpha[i];
        }
      }
      compCtx.putImageData(img, 0, 0, rect.x, rect.y, rect.w, rect.h);
    };
    updateComp(null);

    const view = { zoom: 1, x: 0, y: 0 };
    const pointer = { x: 0, y: 0, inside: false };
    let checker: CanvasPattern | null = null;
    let frame = 0;

    const draw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const dpr = window.devicePixelRatio || 1;
        const cw = canvas.width / dpr, ch = canvas.height / dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#26262b';
        ctx.fillRect(0, 0, cw, ch);
        const bg = propsRef.current.previewBg;
        const ix = view.x, iy = view.y, iw = w * view.zoom, ih = h * view.zoom;
        if (bg === 'checker') {
          checker ??= checkerPattern(ctx);
          ctx.fillStyle = checker;
        } else {
          ctx.fillStyle = BG_COLORS[bg];
        }
        ctx.fillRect(ix, iy, iw, ih);
        ctx.imageSmoothingEnabled = view.zoom < 2;
        ctx.drawImage(comp, ix, iy, iw, ih);
        const p = propsRef.current;
        if (p.tool === 'brush' && pointer.inside) {
          const r = (p.brushSize / 2) * view.zoom;
          ctx.beginPath();
          ctx.arc(pointer.x, pointer.y, Math.max(1, r), 0, Math.PI * 2);
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.strokeStyle = p.keep ? '#4ade80' : '#f87171';
          ctx.stroke();
        }
      });
    };
    drawRef.current = draw;

    const fit = () => {
      const cw = wrap.clientWidth, ch = wrap.clientHeight;
      view.zoom = Math.min(cw / w, ch / h) * 0.95;
      view.x = (cw - w * view.zoom) / 2;
      view.y = (ch - h * view.zoom) / 2;
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(wrap.clientWidth * dpr);
      canvas.height = Math.round(wrap.clientHeight * dpr);
      canvas.style.width = `${wrap.clientWidth}px`;
      canvas.style.height = `${wrap.clientHeight}px`;
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    fit();

    const unsubscribe = editor.subscribe((dirty) => {
      updateComp(dirty);
      draw();
    });

    const toImage = (e: { clientX: number; clientY: number }) => {
      const b = canvas.getBoundingClientRect();
      const sx = e.clientX - b.left, sy = e.clientY - b.top;
      return { sx, sy, x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom };
    };

    let space = false;
    let pan: { sx: number; sy: number; vx: number; vy: number } | null = null;
    let stroke: { x: number; y: number } | null = null;

    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).tagName === 'INPUT') return;
      space = e.type === 'keydown';
      canvas.style.cursor = space ? 'grab' : '';
      e.preventDefault();
    };

    const onDown = (e: PointerEvent) => {
      const p = toImage(e);
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 1 || (e.button === 0 && space)) {
        pan = { sx: p.sx, sy: p.sy, vx: view.x, vy: view.y };
        return;
      }
      const inside = p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
      if (e.button === 2) {
        if (inside) propsRef.current.onPick(Math.floor(p.x), Math.floor(p.y), true);
        return;
      }
      if (e.button !== 0) return;
      const { tool, keep, brushSize } = propsRef.current;
      if (tool === 'brush') {
        editor.beginStroke();
        stroke = { x: p.x, y: p.y };
        editor.brush(p.x, p.y, p.x, p.y, brushSize / 2, keep);
      } else if (inside) {
        propsRef.current.onPick(Math.floor(p.x), Math.floor(p.y), false);
      }
    };

    const onMove = (e: PointerEvent) => {
      const p = toImage(e);
      pointer.x = p.sx;
      pointer.y = p.sy;
      pointer.inside = true;
      if (pan) {
        view.x = pan.vx + p.sx - pan.sx;
        view.y = pan.vy + p.sy - pan.sy;
      } else if (stroke) {
        const { keep, brushSize } = propsRef.current;
        editor.brush(stroke.x, stroke.y, p.x, p.y, brushSize / 2, keep);
        stroke = { x: p.x, y: p.y };
      }
      draw();
    };

    const onUp = () => {
      pan = null;
      if (stroke) {
        stroke = null;
        editor.endStroke();
      }
    };

    const onLeave = () => {
      pointer.inside = false;
      draw();
    };

    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toImage(e);
      const zoom = Math.min(64, Math.max(0.02, view.zoom * Math.pow(1.0015, -e.deltaY)));
      view.x = p.sx - p.x * zoom;
      view.y = p.sy - p.y * zoom;
      view.zoom = zoom;
      draw();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      unsubscribe();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [editor]);

  return (
    <div className="viewport" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}
