import { useRef, type CSSProperties, type ReactNode } from 'react';
import type { PreviewBg, Tool } from './Viewport';

export interface Settings {
  tool: Tool;
  keep: boolean;
  tolerance: number;
  contiguous: boolean;
  brushSize: number;
  minArea: number;
  previewBg: PreviewBg;
  decontam: boolean;
}

export type AutoMode = 'auto' | 'solid' | 'ai';

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'color', label: '颜色点选', key: 'C', hint: '点击某个颜色，按容差选中它' },
  { id: 'sam', label: '智能点选', key: 'S', hint: '左键点击一块区域，AI 选中整块；右键从刚选的区域里排除部分' },
  { id: 'brush', label: '画笔', key: 'B', hint: '手动涂抹，[ ] 调整大小' },
];

const AUTO_MODES: { id: AutoMode; label: string; hint: string }[] = [
  { id: 'auto', label: '自动', hint: '自动判断：纯色背景按颜色去除，否则用 AI' },
  { id: 'solid', label: '纯色', hint: '把图片四边的颜色当作背景色去除' },
  { id: 'ai', label: 'AI', hint: '用 BiRefNet 模型识别主体' },
];

const BGS: { id: PreviewBg; label: string }[] = [
  { id: 'checker', label: '棋盘格' },
  { id: 'white', label: '白' },
  { id: 'black', label: '黑' },
  { id: 'magenta', label: '品红' },
];

const SHORTCUTS: [string, string][] = [
  ['C / S / B', '切换工具'],
  ['X', '切换去除 / 保留'],
  ['[ ]', '画笔大小'],
  ['Ctrl+Z / Ctrl+Y', '撤销 / 重做'],
  ['空格 + 拖动', '平移'],
  ['滚轮', '缩放'],
];

function Icon({ d }: { d: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const UNDO = 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11';
const REDO = 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13';

export function OpenButton(p: { className: string; onOpen(file: File): void; children: ReactNode }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className={p.className} onClick={() => inputRef.current?.click()}>
        {p.children}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) p.onOpen(f);
          e.target.value = '';
        }}
      />
    </>
  );
}

interface TopBarProps {
  fileName: string | null;
  onOpen(file: File): void;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onExport(): void;
  onUndo(): void;
  onRedo(): void;
}

export function TopBar(p: TopBarProps) {
  const off = p.fileName === null || p.busy;
  return (
    <header className="topbar">
      <div className="title">
        <strong>去背景</strong>
        {p.fileName !== null && <span className="filename" title={p.fileName}>{p.fileName}</span>}
      </div>
      <div className="history">
        <button className="icon-btn" disabled={off || !p.canUndo} onClick={p.onUndo} title="撤销（Ctrl+Z）" aria-label="撤销">
          <Icon d={UNDO} />
        </button>
        <button className="icon-btn" disabled={off || !p.canRedo} onClick={p.onRedo} title="重做（Ctrl+Y）" aria-label="重做">
          <Icon d={REDO} />
        </button>
      </div>
      <div className="actions">
        <OpenButton className="btn" onOpen={p.onOpen}>打开</OpenButton>
        <button className="btn primary" disabled={off} onClick={p.onExport}>导出 PNG</button>
      </div>
    </header>
  );
}

function Segmented<T extends string>(p: {
  items: { id: T; label: string; title?: string; className?: string }[];
  value: T | null;
  disabled?: boolean;
  onSelect(id: T): void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={p.label}>
      {p.items.map((it) => (
        <button
          key={it.id}
          className={`${p.value === it.id ? 'active' : ''} ${it.className ?? ''}`}
          aria-pressed={p.value === it.id}
          disabled={p.disabled}
          title={it.title}
          onClick={() => p.onSelect(it.id)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Slider(p: { label: string; value: number; min: number; max: number; onChange(v: number): void }) {
  // The filled part of the track is painted from this percentage, since WebKit has no ::range-progress.
  const pct = ((p.value - p.min) / (p.max - p.min)) * 100;
  return (
    <label className="row slider">
      <span>{p.label}</span>
      <input
        type="range"
        min={p.min}
        max={p.max}
        value={p.value}
        style={{ '--pct': `${pct}%` } as CSSProperties}
        onChange={(e) => p.onChange(+e.target.value)}
      />
      <span className="value">{p.value}</span>
    </label>
  );
}

function Switch(p: { label: string; title: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void }) {
  return (
    <label className="row" title={p.title}>
      <span>{p.label}</span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={p.checked}
        disabled={p.disabled}
        onChange={(e) => p.onChange(e.target.checked)}
      />
    </label>
  );
}

interface InspectorProps {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  hasImage: boolean;
  busy: boolean;
  onAuto(mode: AutoMode): void;
  onIslands(): void;
  onHoles(): void;
  onMorph(grow: boolean): void;
}

export function Inspector(p: InspectorProps) {
  const s = p.settings;
  const off = !p.hasImage || p.busy;
  return (
    <aside className="inspector">
      <section className="card">
        <h2>去背景</h2>
        <Segmented
          label="去背景方式"
          items={AUTO_MODES.map((m) => ({ id: m.id, label: m.label, title: m.hint }))}
          value={null}
          disabled={off}
          onSelect={p.onAuto}
        />
        <p className="hint">点一下即按该方式重新处理整张图</p>
      </section>

      <section className="card">
        <h2>选择工具</h2>
        <Segmented
          label="工具"
          items={TOOLS.map((t) => ({ id: t.id, label: t.label, title: `${t.hint}（${t.key}）` }))}
          value={s.tool}
          onSelect={(tool) => p.onChange({ tool })}
        />
        <Segmented
          label="去除或保留（X 切换）"
          items={[
            { id: 'remove', label: '去除', title: '点选或涂抹的区域变透明（X 切换）', className: 'remove' },
            { id: 'keep', label: '保留', title: '点选或涂抹的区域恢复不透明（X 切换）', className: 'keep' },
          ]}
          value={s.keep ? 'keep' : 'remove'}
          onSelect={(v) => p.onChange({ keep: v === 'keep' })}
        />
        {s.tool === 'color' && (
          <>
            <Slider label="容差" value={s.tolerance} min={1} max={60} onChange={(tolerance) => p.onChange({ tolerance })} />
            <Switch
              label="仅相连区域"
              title="只选与点击处相连的区域；关闭后选中全图同色像素"
              checked={s.contiguous}
              onChange={(contiguous) => p.onChange({ contiguous })}
            />
          </>
        )}
        {s.tool === 'brush' && (
          <Slider label="大小" value={s.brushSize} min={1} max={300} onChange={(brushSize) => p.onChange({ brushSize })} />
        )}
        {s.tool === 'sam' && <p className="hint">左键选中一块区域，右键从刚选的区域里排除不要的部分</p>}
      </section>

      <section className="card">
        <h2>边缘修整</h2>
        <div className="button-grid">
          <button className="btn" disabled={off} onClick={p.onIslands} title="去掉面积小于阈值的孤立残留">清理碎点</button>
          <button className="btn" disabled={off} onClick={p.onHoles} title="填上主体内部面积小于阈值的透明小洞">补小洞</button>
          <button className="btn" disabled={off} onClick={() => p.onMorph(false)} title="边缘向内收 1 像素">收缩</button>
          <button className="btn" disabled={off} onClick={() => p.onMorph(true)} title="边缘向外扩 1 像素">扩展</button>
        </div>
        <label className="row" title="碎点 / 小洞的面积阈值（像素）">
          <span>面积阈值</span>
          <input
            type="number"
            min={1}
            value={s.minArea}
            onChange={(e) => p.onChange({ minArea: Math.max(1, +e.target.value) })}
          />
        </label>
        <Switch
          label="去色边"
          title="去掉半透明边缘上残留的背景色"
          checked={s.decontam}
          disabled={off}
          onChange={(decontam) => p.onChange({ decontam })}
        />
      </section>

      <section className="card">
        <h2>预览背景</h2>
        <div className="swatches" role="group" aria-label="预览背景">
          {BGS.map((b) => (
            <button
              key={b.id}
              className={`swatch swatch-${b.id} ${s.previewBg === b.id ? 'active' : ''}`}
              aria-pressed={s.previewBg === b.id}
              aria-label={b.label}
              title={b.label}
              onClick={() => p.onChange({ previewBg: b.id })}
            />
          ))}
        </div>
      </section>

      <details className="shortcuts">
        <summary>快捷键</summary>
        <dl>
          {SHORTCUTS.map(([k, v]) => (
            <div key={k}>
              <dt><kbd>{k}</kbd></dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </details>
    </aside>
  );
}
