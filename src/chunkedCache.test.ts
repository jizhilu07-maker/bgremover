import { describe, expect, it } from 'vitest';
import { createChunkedCache, type CacheLike } from './chunkedCache';

function memoryCache(): CacheLike & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    async match(k) { return store.get(k)?.clone(); },
    async put(k, r) { store.set(k, r); },
  };
}

function server(files: Record<string, Uint8Array | string>) {
  const requests: string[] = [];
  const fetchFn = (async (url: string) => {
    requests.push(url);
    const body = files[url];
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body as BodyInit);
  }) as typeof fetch;
  return { fetchFn, requests };
}

describe('createChunkedCache', () => {
  const whole = Uint8Array.from({ length: 1000 }, (_, i) => (i * 31) % 256);
  const url = 'http://x/models/m/onnx/model.onnx';
  const files = {
    [`${url}.parts.json`]: JSON.stringify({ size: 1000, parts: 3 }),
    [`${url}.part0`]: whole.slice(0, 400),
    [`${url}.part1`]: whole.slice(400, 800),
    [`${url}.part2`]: whole.slice(800),
  };

  it('joins the parts byte-for-byte and caches the result', async () => {
    const cache = memoryCache();
    const { fetchFn, requests } = server(files);
    const progress: number[] = [];
    const c = createChunkedCache(async () => cache, (_, loaded) => progress.push(loaded), fetchFn);

    const res = await c.match(url);
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(whole);
    expect(progress).toEqual([400, 800, 1000]);

    const n = requests.length;
    const again = await c.match(url);
    expect(new Uint8Array(await again!.arrayBuffer())).toEqual(whole);
    expect(requests.length).toBe(n); // served from cache
  });

  it('returns undefined for unchunked files so transformers.js fetches them normally', async () => {
    const { fetchFn } = server({});
    const c = createChunkedCache(async () => memoryCache(), () => {}, fetchFn);
    expect(await c.match('http://x/models/s/onnx/small.onnx')).toBeUndefined();
    expect(await c.match('http://x/models/s/config.json')).toBeUndefined();
  });

  it('ignores an HTML fallback page served in place of a missing manifest', async () => {
    const { fetchFn } = server({ 'http://x/a.onnx.parts.json': '<!doctype html><html></html>' });
    const c = createChunkedCache(async () => null, () => {}, fetchFn);
    expect(await c.match('http://x/a.onnx')).toBeUndefined();
  });

  it('fails loudly when a part is missing', async () => {
    const { [`${url}.part1`]: _missing, ...rest } = files;
    void _missing;
    const { fetchFn } = server(rest);
    const c = createChunkedCache(async () => null, () => {}, fetchFn);
    await expect(c.match(url)).rejects.toThrow(/part1/);
  });
});
