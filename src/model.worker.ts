import {
  AutoModel,
  AutoProcessor,
  RawImage,
  SamModel,
  Tensor,
  env,
  type PreTrainedModel,
  type Processor,
} from '@huggingface/transformers';
import { createChunkedCache } from './chunkedCache';
import { resizeBilinear } from './mask/edge';

// Absolute URL of the site root, passed in as the worker name by modelClient. The site may live
// under a sub-path (GitHub Pages: /<repo>/), so asset paths cannot start with '/'.
const ASSET_BASE = self.name;

// Everything is served by this site (see scripts/prepare-assets.mjs): no huggingface.co, no CDN.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${ASSET_BASE}models/`;
// Only the .wasm is overridden: the JS glue is already bundled in onnxruntime-web, and pointing
// ORT at a separate .mjs under /public makes Vite refuse the dynamic import.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = { wasm: `${ASSET_BASE}ort/ort-wasm-simd-threaded.jsep.wasm` };
}

const BIREFNET = 'birefnet-lite-1024-webgpu';
const SAM = 'slimsam-77-uniform';

// Wraps the browser cache so models split into <100MB chunks are reassembled transparently.
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = createChunkedCache(
  async () => {
    try {
      return await caches.open('transformers-cache');
    } catch {
      // Cache storage can be blocked (private mode, iframes); then every visit downloads again.
      return null;
    }
  },
  (url, loaded, total) => {
    post({ type: 'progress', model: url.includes(BIREFNET) ? 'birefnet' : 'sam', percent: Math.round((loaded / total) * 100) });
  },
);

type Device = 'webgpu' | 'wasm';

export type WorkerRequest =
  | { id: number; type: 'removeBg'; rgb: Uint8Array; width: number; height: number }
  | { id: number; type: 'samEncode'; rgb: Uint8Array; width: number; height: number }
  /** Normalised (0..1) image coordinates of one positive point. */
  | { id: number; type: 'samDecode'; x: number; y: number };

export type WorkerMessage =
  | { type: 'progress'; model: 'birefnet' | 'sam'; percent: number }
  | { type: 'device'; device: Device }
  | { id: number; ok: true; prob?: Float32Array; probWidth?: number; probHeight?: number }
  | { id: number; ok: false; error: string };

/** Sentinel errors; modelClient turns them into user-facing messages. */
const NO_WEBGPU = 'NO_WEBGPU';
const GPU_UNSUPPORTED = 'GPU_UNSUPPORTED';
const GPU_BAD_OUTPUT = 'GPU_BAD_OUTPUT';

const post = (msg: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

interface MinimalAdapter {
  limits: { maxStorageBuffersPerShaderStage: number };
}

const gpu: Promise<{ device: Device; canRunBirefnet: boolean }> = (async () => {
  try {
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<MinimalAdapter | null> } };
    const adapter = await nav.gpu?.requestAdapter();
    if (!adapter) return { device: 'wasm', canRunBirefnet: false };
    // The BiRefNet graph was patched to need at most 8 storage buffers per shader.
    const canRunBirefnet = adapter.limits.maxStorageBuffersPerShaderStage >= 8;
    return { device: 'webgpu', canRunBirefnet };
  } catch {
    return { device: 'wasm', canRunBirefnet: false };
  }
})();
const device = gpu.then((g) => g.device);

function progressFor(model: 'birefnet' | 'sam') {
  const files = new Map<string, { loaded: number; total: number }>();
  return (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== 'progress' || !p.file || !p.total) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    post({ type: 'progress', model, percent: Math.round((loaded / total) * 100) });
  };
}

let birefnet: Promise<{ model: PreTrainedModel; processor: Processor }> | null = null;
function loadBirefnet() {
  birefnet ??= (async () => {
    // WebGPU only: on the WASM backend this model exceeds the 32-bit heap, and a failed run leaves
    // the shared ORT runtime unusable (SAM breaks too). Check before downloading 225MB.
    const g = await gpu;
    if (g.device !== 'webgpu') throw new Error(NO_WEBGPU);
    if (!g.canRunBirefnet) throw new Error(GPU_UNSUPPORTED);
    const model = await AutoModel.from_pretrained(BIREFNET, {
      device: 'webgpu',
      // fp32 on purpose: the fp16 export overflows to an all-NaN output on some GPUs.
      dtype: 'fp32',
      progress_callback: progressFor('birefnet'),
    });
    post({ type: 'device', device: 'webgpu' });
    return { model, processor: await AutoProcessor.from_pretrained(BIREFNET, {}) };
  })().catch((e) => { birefnet = null; throw e; });
  return birefnet;
}

let sam: Promise<{ model: SamModel; processor: Processor }> | null = null;
function loadSam() {
  sam ??= (async () => {
    const load = async (d: Device) => (await SamModel.from_pretrained(SAM, {
      // The decoder is tiny and runs per click; keeping it on WASM avoids a GPU round trip.
      device: d === 'webgpu' ? { vision_encoder: 'webgpu', prompt_encoder_mask_decoder: 'wasm' } : 'wasm',
      dtype: 'fp32',
      progress_callback: progressFor('sam'),
    })) as SamModel;
    let d = await device;
    let model: SamModel;
    try {
      model = await load(d);
    } catch (e) {
      // Some GPUs/drivers fail to build a WebGPU session; SlimSAM is small enough for CPU.
      if (d === 'wasm') throw e;
      d = 'wasm';
      model = await load(d);
    }
    post({ type: 'device', device: d });
    return { model, processor: await AutoProcessor.from_pretrained(SAM, {}) };
  })().catch((e) => { sam = null; throw e; });
  return sam;
}

// SAM image embeddings for the current image; computed once, reused for every click.
let samState: {
  inputs: { reshaped_input_sizes: number[][] };
  embeddings: Record<string, Tensor>;
} | null = null;

async function handle(req: WorkerRequest): Promise<void> {
  if (req.type === 'removeBg') {
    const { model, processor } = await loadBirefnet();
    const { pixel_values } = await processor(new RawImage(req.rgb, req.width, req.height, 3));
    const { output_image } = await model({ input_image: pixel_values });
    const prob = (output_image as Tensor).sigmoid();
    const [ph, pw] = prob.dims.slice(-2);
    const data = new Float32Array(prob.data as Float32Array);
    // A broken GPU result would otherwise show up as a silently empty (fully transparent) mask.
    if (data.some(Number.isNaN)) throw new Error(GPU_BAD_OUTPUT);
    post({ id: req.id, ok: true, prob: data, probWidth: pw, probHeight: ph }, [data.buffer]);
  } else if (req.type === 'samEncode') {
    samState = null;
    const { model, processor } = await loadSam();
    const inputs = await processor(new RawImage(req.rgb, req.width, req.height, 3));
    samState = { inputs, embeddings: await model.get_image_embeddings(inputs) };
    post({ id: req.id, ok: true });
  } else {
    if (!samState) throw new Error('SAM: image not encoded');
    const { model } = await loadSam();
    const [rh, rw] = samState.inputs.reshaped_input_sizes[0];
    // Always a single point: this export only has the 3 multimask outputs, which handle multi-point
    // prompts (several objects, or exclusion points) badly. The app combines single-object masks.
    const input_points = new Tensor('float32', new Float32Array([req.x * rw, req.y * rh]), [1, 1, 1, 2]);
    const input_labels = new Tensor('int64', new BigInt64Array([1n]), [1, 1, 1]);
    const out = await model({ ...samState.embeddings, input_points, input_labels });
    const scores = out.iou_scores.data as Float32Array;
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;

    // Threshold at logit 0 like SAM's own post-processing: its logits are not an alpha matte and
    // their sigmoid ramps over ~15px, which shows up as wide translucent residue. The main thread
    // then snaps this hard edge to the image with the guided filter.
    const [lh, lw] = (out.pred_masks as Tensor).dims.slice(-2);
    const logits = (out.pred_masks.data as Float32Array).subarray(best * lh * lw, (best + 1) * lh * lw);
    // Low-res masks cover the padded 1024² model input; keep only the part that holds the image.
    const pad = 1024;
    const full = resizeBilinear(Float32Array.from(logits), lw, lh, pad, pad);
    const prob = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) prob[y * rw + x] = full[y * pad + x] > 0 ? 1 : 0;
    }
    post({ id: req.id, ok: true, prob, probWidth: rw, probHeight: rh }, [prob.buffer]);
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  handle(e.data).catch((err: unknown) => {
    post({ id: e.data.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  });
};
