// Puts everything the browser needs for AI features under public/, so the site never calls
// huggingface.co or a CDN at runtime. Files over GitHub's 100MB limit are stored as chunks
// (<file>.part0, .part1, … plus <file>.parts.json); the worker reassembles them (src/chunkedCache.ts).
//   npm run assets
//   HF_ENDPOINT=https://hf-mirror.com npm run assets   (when huggingface.co is unreachable)
// Converting BiRefNet to fp32 needs Python with `pip install onnx numpy` (set PYTHON to pick one).
import { copyFile, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/$/, '');

const MODELS = [
  {
    // BiRefNet-lite with the graph patched to run fully on WebGPU (same weights). The
    // onnx-community export falls back to the CPU for its deform-conv nodes and runs out of the
    // 32-bit wasm heap; see the repo's README. It is published in fp16 only, which overflows to an
    // all-NaN output on some GPUs, so it is converted to fp32 here.
    repo: 'jiabins0303/birefnet-lite-1024-webgpu',
    dir: 'birefnet-lite-1024-webgpu',
    files: ['config.json', 'preprocessor_config.json', 'onnx/model_fp16.onnx'],
    toFp32: { 'onnx/model_fp16.onnx': 'onnx/model.onnx' },
  },
  {
    repo: 'Xenova/slimsam-77-uniform',
    dir: 'slimsam-77-uniform',
    files: ['config.json', 'preprocessor_config.json', 'onnx/vision_encoder.onnx', 'onnx/prompt_encoder_mask_decoder.onnx'],
  },
];

// The native-WebGPU onnxruntime-web build (see the alias in vite.config.ts); it also runs the WASM backend.
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.wasm'];

// Below GitHub's hard 100MB per-file limit, with headroom.
const CHUNK_BYTES = 90 * 1024 * 1024;

const exists = (p) => stat(p).then((s) => s.size > 0, () => false);

async function splitIfLarge(file) {
  const { size } = await stat(file);
  if (size <= CHUNK_BYTES) return;
  const parts = Math.ceil(size / CHUNK_BYTES);
  for (let i = 0; i < parts; i++) {
    const end = Math.min(size, (i + 1) * CHUNK_BYTES) - 1;
    await pipeline(createReadStream(file, { start: i * CHUNK_BYTES, end }), createWriteStream(`${file}.part${i}`));
  }
  await writeFile(`${file}.parts.json`, JSON.stringify({ size, parts }));
  // The whole file must not stay under public/: it would end up in the repo and GitHub rejects it.
  await unlink(file);
  console.log(`  split into ${parts} parts`);
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0, lastPct = -1;
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      const pct = total ? Math.floor((done / total) * 100) : -1;
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        process.stdout.write(`  ${pct}%`);
      }
      cb(null, chunk);
    },
  });
  const tmp = `${dest}.download`;
  await pipeline(Readable.fromWeb(res.body), progress, createWriteStream(tmp));
  await rename(tmp, dest);
  process.stdout.write('\n');
}

async function main() {
  const ortSrc = join(root, 'node_modules', 'onnxruntime-web', 'dist');
  const ortDest = join(root, 'public', 'ort');
  await mkdir(ortDest, { recursive: true });
  for (const f of ORT_FILES) await copyFile(join(ortSrc, f), join(ortDest, f));
  console.log(`ORT runtime -> public/ort (${ORT_FILES.length} files)`);

  for (const m of MODELS) {
    for (const f of m.files) {
      const fp32 = m.toFp32?.[f];
      const dest = join(root, 'public', 'models', m.dir, fp32 ?? f);
      if (await exists(`${dest}.parts.json`)) {
        console.log(`skip ${m.dir}/${fp32 ?? f} (already split)`);
        continue;
      }
      if (await exists(dest)) {
        console.log(`have ${m.dir}/${fp32 ?? f}`);
      } else {
        const src = join(root, 'public', 'models', m.dir, f);
        await mkdir(dirname(src), { recursive: true });
        if (!(await exists(src))) {
          console.log(`download ${m.repo}/${f}`);
          await download(`${endpoint}/${m.repo}/resolve/main/${f}`, src);
        }
        if (fp32) {
          console.log(`convert ${f} -> ${fp32}`);
          execFileSync(process.env.PYTHON || 'python', [join(root, 'scripts', 'fp16_to_fp32.py'), src, dest], { stdio: 'inherit' });
          await unlink(src);
        }
      }
      await splitIfLarge(dest);
    }
  }
  console.log('done');
}

main().catch((e) => {
  console.error(`\nfailed: ${e.message}`);
  console.error('If huggingface.co is unreachable, retry with HF_ENDPOINT=https://hf-mirror.com');
  process.exit(1);
});
