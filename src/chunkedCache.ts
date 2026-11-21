/** The part of the Web Cache API that transformers.js calls on `env.customCache`. */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

interface PartsManifest { size: number; parts: number }

async function readManifest(fetchFn: typeof fetch, url: string): Promise<PartsManifest | null> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const m = (await res.json()) as PartsManifest;
    return Number.isInteger(m.size) && Number.isInteger(m.parts) ? m : null;
  } catch {
    // Missing manifest, or a dev server answering with an HTML fallback page.
    return null;
  }
}

/**
 * GitHub rejects files over 100MB, so large models are stored as `<file>.part0…N` plus
 * `<file>.parts.json` (see scripts/prepare-assets.mjs). transformers.js asks its cache for every
 * file before fetching it; this cache answers for chunked .onnx files by downloading and joining
 * the parts, and keeps the joined file in the browser cache so it is fetched only once.
 */
export function createChunkedCache(
  open: () => Promise<CacheLike | null>,
  onProgress: (url: string, loaded: number, total: number) => void,
  fetchFn: typeof fetch = fetch,
): CacheLike {
  return {
    async match(key) {
      const cache = await open();
      const hit = await cache?.match(key);
      if (hit || !key.endsWith('.onnx')) return hit;

      const manifest = await readManifest(fetchFn, `${key}.parts.json`);
      if (!manifest) return undefined;
      const joined = new Uint8Array(manifest.size);
      let offset = 0;
      for (let i = 0; i < manifest.parts; i++) {
        const res = await fetchFn(`${key}.part${i}`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${key}.part${i}`);
        const part = new Uint8Array(await res.arrayBuffer());
        if (offset + part.length > manifest.size) throw new Error(`Chunked file larger than expected: ${key}`);
        joined.set(part, offset);
        offset += part.length;
        onProgress(key, offset, manifest.size);
      }
      if (offset !== manifest.size) throw new Error(`Chunked file incomplete (${offset}/${manifest.size}): ${key}`);

      const response = new Response(joined, { headers: { 'content-length': String(manifest.size) } });
      await cache?.put(key, response.clone());
      return response;
    },
    async put(key, response) {
      await (await open())?.put(key, response);
    },
  };
}
