import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeBorder, isSolidBackground, removeSolidBackground } from './auto';
import { Editor } from './Editor';
import { fillHoles, removeIslands } from './mask/cleanup';
import { sampleColor, selectByColor } from './mask/color';
import { morph, refineWithGuide, snapToColors } from './mask/edge';
import { ModelClient } from './modelClient';
import { encodePng } from './png';
import { Toolbar, type AutoMode, type Settings } from './Toolbar';
import { Viewport } from './Viewport';

const DEFAULT_SETTINGS: Settings = {
  tool: 'color',
  keep: false,
  tolerance: 12,
  contiguous: true,
  brushSize: 30,
  minArea: 20,
  previewBg: 'checker',
  decontam: true,
};

const MODEL_NAMES = { birefnet: 'BiRefNet', sam: 'SAM' } as const;

async function decodeImage(file: Blob): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const bmp = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
}

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // transformers.js reports a missing local file as a generic load failure.
  if (/local|404|Could not locate|Unable to load/i.test(msg)) return `${msg}（模型文件可能还没准备好：先运行 npm run assets）`;
  return msg;
}

export function App() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('拖入、粘贴或打开一张图片');
  const [device, setDevice] = useState('');
  const [fileName, setFileName] = useState('image');
  const [, setHistoryVersion] = useState(0);
  const modelRef = useRef<ModelClient | null>(null);
  // The latest smart-select object, kept so right clicks can refine it. Any other mask change ends it.
  const samRef = useRef<{ editor: Editor; version: number; keep: boolean; base: Uint8Array; sel: Uint8Array; excluded: number } | null>(null);

  const model = useCallback(() => {
    modelRef.current ??= new ModelClient({
      onProgress: (m, pct) => setStatus(`正在加载 ${MODEL_NAMES[m]} 模型… ${pct}%`),
      onDevice: (d) => setDevice(d === 'webgpu' ? 'WebGPU' : 'WASM (CPU)'),
    });
    return modelRef.current;
  }, []);

  useEffect(() => {
    if (!editor) return;
    return editor.subscribe((_, historyChanged) => {
      if (historyChanged) setHistoryVersion((v) => v + 1);
    });
  }, [editor]);

  const withBusy = useCallback(async (label: string, fn: () => Promise<string | void>) => {
    setBusy(true);
    setStatus(label);
    try {
      const done = await fn();
      if (done) setStatus(done);
    } catch (e) {
      setStatus(`出错：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const runAuto = useCallback(
    (ed: Editor, mode: AutoMode) =>
      withBusy('正在去除背景…', async () => {
        // Let React paint the busy state before the synchronous colour pass blocks the thread.
        await new Promise((r) => setTimeout(r, 0));
        const { rgba, width: w, height: h } = ed;
        const border = analyzeBorder(rgba, w, h);
        if (mode === 'solid' || (mode === 'auto' && isSolidBackground(border))) {
          ed.bg = border.color;
          ed.commit(removeSolidBackground(rgba, w, h, border));
          return `已按纯色背景去除（背景色 rgb(${border.color.join(', ')})，容差 ${border.tolerance.toFixed(0)}）。换个预览背景检查一下边缘`;
        }
        ed.bg = null;
        const r = await model().removeBackground(rgba, w, h);
        ed.commit(refineWithGuide(r.prob, r.width, r.height, rgba, w, h));
        return 'AI 去背景完成。换个预览背景检查残留和边缘';
      }),
    [model, withBusy],
  );

  const loadFile = useCallback(
    async (file: Blob, name: string) => {
      if (!file.type.startsWith('image/')) return;
      try {
        const { rgba, width, height } = await decodeImage(file);
        const ed = new Editor(rgba, width, height);
        if (settings.decontam) ed.setDecontaminate(true);
        setFileName(name.replace(/\.[^.]+$/, '') || 'image');
        setEditor(ed);
        let transparent = false;
        for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) { transparent = true; break; }
        if (transparent) {
          const a = new Uint8Array(width * height);
          for (let i = 0; i < a.length; i++) a[i] = rgba[i * 4 + 3];
          ed.commit(a);
          setStatus('图片自带透明通道，已直接沿用。需要重新处理请点"自动去背景"');
        } else {
          await runAuto(ed, 'auto');
        }
        if (Math.max(width, height) > 4096) setStatus((s) => `${s}（图片超过 4K，处理会比较慢）`);
      } catch (e) {
        setStatus(`无法读取图片：${errorText(e)}`);
      }
    },
    [runAuto, settings.decontam],
  );

  const onPick = useCallback(
    (x: number, y: number, exclude: boolean) => {
      if (!editor || busy) return;
      const { rgba, width: w, height: h } = editor;
      if (settings.tool === 'color') {
        if (exclude) return;
        const target = sampleColor(rgba, w, h, x, y);
        const sel = selectByColor(rgba, w, h, target, settings.tolerance, settings.contiguous ? [y * w + x] : null);
        editor.applySelection(sel, settings.keep);
      } else if (settings.tool === 'sam') {
        // Left click = a new object. Right click = cut the clicked object out of the latest
        // selection (sel × (1 − other)), re-applied onto the mask as it was before that selection.
        const prev = samRef.current;
        const canRefine = !!prev && prev.editor === editor && prev.version === editor.version && prev.keep === settings.keep;
        if (exclude && !canRefine) {
          setStatus('先左键点选一块区域，再用右键排除其中不要的部分');
          return;
        }
        const keep = settings.keep;
        void withBusy('智能点选：计算中（每张图第一次会慢一些）…', async () => {
          const r = await model().samSelect(rgba, w, h, x, y);
          const obj = snapToColors(r.prob, r.width, r.height, rgba, w, h);
          let session;
          if (exclude && prev) {
            const sel = prev.sel.map((v, i) => Math.round((v * (255 - obj[i])) / 255));
            session = { ...prev, sel, excluded: prev.excluded + 1 };
          } else {
            session = { editor, version: -1, keep, base: editor.alpha.slice(), sel: obj, excluded: 0 };
          }
          editor.applySelection(session.sel, keep, session.base);
          samRef.current = { ...session, version: editor.version };
          const n = session.excluded;
          return `智能点选完成${n ? `（已排除 ${n} 处）` : ''}：左键再选另一块，右键从这一块里排除不要的部分`;
        });
      }
    },
    [editor, busy, settings, model, withBusy],
  );

  const exportPng = useCallback(() => {
    if (!editor) return;
    void withBusy('正在导出…', async () => {
      const png = await encodePng(editor.exportRgba(), editor.width, editor.height);
      const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileName}-透明.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return `已导出 ${a.download}`;
    });
  }, [editor, fileName, withBusy]);

  const change = useCallback(
    (patch: Partial<Settings>) => {
      if (patch.decontam !== undefined && editor) editor.setDecontaminate(patch.decontam);
      setSettings((s) => ({ ...s, ...patch }));
    },
    [editor],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLInputElement;
      if (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox') return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (!editor || busy) return;
        if (k === 'z' && !e.shiftKey) editor.undo();
        else if (k === 'y' || (k === 'z' && e.shiftKey)) editor.redo();
        else return;
        e.preventDefault();
        return;
      }
      if (k === 'x') setSettings((s) => ({ ...s, keep: !s.keep }));
      else if (k === 'c') setSettings((s) => ({ ...s, tool: 'color' }));
      else if (k === 's') setSettings((s) => ({ ...s, tool: 'sam' }));
      else if (k === 'b') setSettings((s) => ({ ...s, tool: 'brush' }));
      else if (k === '[') setSettings((s) => ({ ...s, brushSize: Math.max(1, Math.round(s.brushSize / 1.2)) }));
      else if (k === ']') setSettings((s) => ({ ...s, brushSize: Math.min(300, Math.round(s.brushSize * 1.2) + 1) }));
    };
    const onPaste = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files ?? []).find((x) => x.type.startsWith('image/'));
      if (f) void loadFile(f, f.name || 'pasted');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [editor, busy, loadFile]);

  const maskOp = (fn: (a: Uint8Array, w: number, h: number) => Uint8Array) => () => {
    if (editor) editor.commit(fn(editor.alpha, editor.width, editor.height));
  };

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) void loadFile(f, f.name);
      }}
    >
      <Toolbar
        settings={settings}
        onChange={change}
        hasImage={!!editor}
        busy={busy}
        canUndo={!!editor?.canUndo}
        canRedo={!!editor?.canRedo}
        onOpen={(f) => void loadFile(f, f.name)}
        onAuto={(m) => editor && void runAuto(editor, m)}
        onExport={exportPng}
        onUndo={() => editor?.undo()}
        onRedo={() => editor?.redo()}
        onIslands={maskOp((a, w, h) => removeIslands(a, w, h, settings.minArea))}
        onHoles={maskOp((a, w, h) => fillHoles(a, w, h, settings.minArea))}
        onMorph={(grow) => maskOp((a, w, h) => morph(a, w, h, grow))()}
      />
      {editor ? (
        <Viewport
          editor={editor}
          tool={settings.tool}
          keep={settings.keep}
          brushSize={settings.brushSize}
          previewBg={settings.previewBg}
          onPick={onPick}
        />
      ) : (
        <div className="viewport empty">拖入、粘贴（Ctrl+V）或点击"打开图片"</div>
      )}
      <div className="statusbar">
        <span>{busy ? '⏳ ' : ''}{status}</span>
        <span className="muted">
          {editor && `${editor.width}×${editor.height}`}
          {device && ` · ${device}`}
          {' · 空格+拖动平移，滚轮缩放，X 切换去除/保留'}
        </span>
      </div>
    </div>
  );
}
