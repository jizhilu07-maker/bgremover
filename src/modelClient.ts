import type { WorkerMessage, WorkerRequest } from './model.worker';

type Pending = { resolve: (m: Extract<WorkerMessage, { ok: true }>) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface ModelEvents {
  onProgress(model: 'birefnet' | 'sam', percent: number): void;
  onDevice(device: string): void;
}

function toRgb(rgba: Uint8ClampedArray): Uint8Array {
  const n = rgba.length >> 2;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return rgb;
}

/** Main-thread side of model.worker.ts. Requests are run one at a time; the worker holds per-image SAM state. */
export class ModelClient {
  // The worker name carries the site root URL (the site may be served from a sub-path such as
  // GitHub Pages' /<repo>/); the worker resolves model and wasm URLs against it.
  private worker = new Worker(new URL('./model.worker.ts', import.meta.url), {
    type: 'module',
    name: new URL('.', location.href).href,
  });
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private samImage: Uint8ClampedArray | null = null;
  private events: ModelEvents;

  constructor(events: ModelEvents) {
    this.events = events;
    this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if ('type' in m) {
        if (m.type === 'progress') this.events.onProgress(m.model, m.percent);
        else this.events.onDevice(m.device);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m);
      else if (m.error === 'NO_WEBGPU') {
        p.reject(new Error('这个浏览器没有可用的 WebGPU，AI 去背景无法运行（CPU 模式下模型内存不够）。请用最新版 Chrome/Edge，或改用「智能点选」点击背景去除'));
      } else p.reject(new Error(m.error));
    };
  }

  private request(req: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[] = []) {
    const run = () =>
      new Promise<Extract<WorkerMessage, { ok: true }>>((resolve, reject) => {
        const id = this.nextId++;
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ ...req, id }, transfer);
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** BiRefNet foreground probability at model resolution. */
  async removeBackground(rgba: Uint8ClampedArray, width: number, height: number) {
    const rgb = toRgb(rgba);
    const r = await this.request({ type: 'removeBg', rgb, width, height }, [rgb.buffer]);
    return { prob: r.prob!, width: r.probWidth!, height: r.probHeight! };
  }

  /** SAM mask (0/1, covering the whole image at model resolution) of the object at pixel (x, y). */
  async samSelect(rgba: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
    if (this.samImage !== rgba) {
      const rgb = toRgb(rgba);
      this.samImage = rgba;
      try {
        await this.request({ type: 'samEncode', rgb, width, height }, [rgb.buffer]);
      } catch (e) {
        this.samImage = null;
        throw e;
      }
    }
    const r = await this.request({ type: 'samDecode', x: (x + 0.5) / width, y: (y + 0.5) / height });
    return { prob: r.prob!, width: r.probWidth!, height: r.probHeight! };
  }
}
