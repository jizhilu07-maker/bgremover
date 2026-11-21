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

interface Props {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  hasImage: boolean;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onOpen(file: File): void;
  onAuto(mode: AutoMode): void;
  onExport(): void;
  onUndo(): void;
  onRedo(): void;
  onIslands(): void;
  onHoles(): void;
  onMorph(grow: boolean): void;
}

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'color', label: '颜色点选', key: 'C', hint: '点击某个颜色，按容差选中它' },
  { id: 'sam', label: '智能点选', key: 'S', hint: '左键点击一块区域，AI 选中整块；右键从刚选的区域里排除部分' },
  { id: 'brush', label: '画笔', key: 'B', hint: '手动涂抹，[ ] 调整大小' },
];

const BGS: { id: PreviewBg; label: string }[] = [
  { id: 'checker', label: '棋盘格' },
  { id: 'white', label: '白' },
  { id: 'black', label: '黑' },
  { id: 'magenta', label: '品红' },
];

export function Toolbar(p: Props) {
  const s = p.settings;
  const off = !p.hasImage || p.busy;
  return (
    <div className="toolbar">
      <section>
        <label className="btn primary">
          打开图片
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onOpen(f);
              e.target.value = '';
            }}
          />
        </label>
        <button disabled={off} onClick={() => p.onAuto('auto')} title="自动判断：纯色背景按颜色去除，否则用 AI">自动去背景</button>
        <button disabled={off} onClick={() => p.onAuto('solid')} title="把图片四边的颜色当作背景色去除">按纯色</button>
        <button disabled={off} onClick={() => p.onAuto('ai')} title="用 BiRefNet 模型识别主体">按 AI</button>
        <button className="primary" disabled={off} onClick={p.onExport}>导出 PNG</button>
      </section>

      <section>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={s.tool === t.id ? 'active' : ''}
            title={`${t.hint}（${t.key}）`}
            onClick={() => p.onChange({ tool: t.id })}
          >
            {t.label}
          </button>
        ))}
        <span className="seg" title="切换：X">
          <button className={!s.keep ? 'active remove' : ''} onClick={() => p.onChange({ keep: false })}>去除</button>
          <button className={s.keep ? 'active keep' : ''} onClick={() => p.onChange({ keep: true })}>保留</button>
        </span>
        {s.tool === 'color' && (
          <>
            <label>
              容差 {s.tolerance}
              <input type="range" min={1} max={60} value={s.tolerance} onChange={(e) => p.onChange({ tolerance: +e.target.value })} />
            </label>
            <label title="只选与点击处相连的区域；关闭后选中全图同色像素">
              <input type="checkbox" checked={s.contiguous} onChange={(e) => p.onChange({ contiguous: e.target.checked })} />
              仅相连
            </label>
          </>
        )}
        {s.tool === 'brush' && (
          <label>
            大小 {s.brushSize}
            <input type="range" min={1} max={300} value={s.brushSize} onChange={(e) => p.onChange({ brushSize: +e.target.value })} />
          </label>
        )}
      </section>

      <section>
        <button disabled={off} onClick={p.onIslands} title="去掉面积小于阈值的孤立残留">清理碎点</button>
        <button disabled={off} onClick={p.onHoles} title="填上主体内部面积小于阈值的透明小洞">补小洞</button>
        <label title="碎点/小洞的面积阈值（像素）">
          面积 ≤
          <input type="number" min={1} value={s.minArea} onChange={(e) => p.onChange({ minArea: Math.max(1, +e.target.value) })} />
        </label>
        <button disabled={off} onClick={() => p.onMorph(false)} title="边缘向内收 1 像素">收缩</button>
        <button disabled={off} onClick={() => p.onMorph(true)} title="边缘向外扩 1 像素">扩展</button>
        <label title="去掉半透明边缘上残留的背景色">
          <input type="checkbox" disabled={off} checked={s.decontam} onChange={(e) => p.onChange({ decontam: e.target.checked })} />
          去色边
        </label>
        <button disabled={off || !p.canUndo} onClick={p.onUndo} title="Ctrl+Z">撤销</button>
        <button disabled={off || !p.canRedo} onClick={p.onRedo} title="Ctrl+Y">重做</button>
      </section>

      <section>
        <span className="muted">预览背景</span>
        <span className="seg">
          {BGS.map((b) => (
            <button key={b.id} className={s.previewBg === b.id ? 'active' : ''} onClick={() => p.onChange({ previewBg: b.id })}>
              {b.label}
            </button>
          ))}
        </span>
      </section>
    </div>
  );
}
