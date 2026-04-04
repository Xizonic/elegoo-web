/**
 * REST API and camera proxy.
 *
 * Endpoints:
 *   GET /api/status    — Current printer state as JSON
 *   GET /api/snapshot  — Camera JPEG snapshot (proxied + cached)
 *   GET /api/health    — Service health check
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { StateStore } from './state-store.js';
import type { ServiceConfig } from './config.js';

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const CACHE_TTL_MS = 5_000;

let cachedSnapshot: Buffer | null = null;
let cacheTime = 0;
let fetchInFlight: Promise<Buffer | null> | null = null;

async function fetchCameraFrame(cameraUrl: string): Promise<Buffer | null> {
  // Return cached snapshot if fresh
  if (cachedSnapshot && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  // Serialize concurrent requests
  if (fetchInFlight) return fetchInFlight;

  fetchInFlight = doFetch(cameraUrl);
  try {
    const result = await fetchInFlight;
    if (result) {
      cachedSnapshot = result;
      cacheTime = Date.now();
    }
    return result;
  } finally {
    fetchInFlight = null;
  }
}

async function doFetch(cameraUrl: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(cameraUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) {
      return Buffer.from(await res.arrayBuffer());
    }

    // MJPEG stream — extract first frame
    if (!res.body) return null;
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let totalLen = 0;

    try {
      while (totalLen < 5 * 1024 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        chunks.push(buf);
        totalLen += buf.length;

        const combined = Buffer.concat(chunks);
        const startIdx = combined.indexOf(JPEG_START);
        if (startIdx === -1) continue;
        const endIdx = combined.indexOf(JPEG_END, startIdx + 2);
        if (endIdx === -1) continue;

        reader.cancel();
        return combined.subarray(startIdx, endIdx + 2);
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    return null;
  } catch (err) {
    console.warn(`[Camera] Snapshot failed: ${(err as Error).message}`);
    return null;
  }
}

/** Shared snapshot fetcher — used by both REST API and Telegram */
export async function getSnapshot(config: ServiceConfig): Promise<Buffer | null> {
  if (!config.cameraEnabled) return null;
  return fetchCameraFrame(config.cameraUrl);
}

export function createRestRouter(store: StateStore, config: ServiceConfig) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';

    // CORS headers for API routes
    if (url.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        mqtt: store.attributes ? 'connected' : 'disconnected',
        clients: 0, // filled in by ws-transport if needed
      }));
      return;
    }

    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        attributes: store.attributes,
        status: store.status,
        canvas: store.canvas,
        files: store.files,
      }));
      return;
    }

    if (url === '/api/snapshot') {
      getSnapshot(config).then((jpeg) => {
        if (jpeg) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'no-cache',
            'Content-Length': jpeg.length,
          });
          res.end(jpeg);
        } else {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('Camera unavailable');
        }
      }).catch(() => {
        res.writeHead(500);
        res.end('Internal error');
      });
      return;
    }

    // Not an API route — let ws-transport or 404 handle it
    res.writeHead(404);
    res.end('Not found');
  };
}
