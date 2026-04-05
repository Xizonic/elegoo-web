/**
 * REST API and camera proxy.
 *
 * Endpoints:
 *   GET /api/status    — Current printer state as JSON
 *   GET /api/snapshot  — Camera JPEG snapshot (proxied + cached)
 *   GET /api/stream    — MJPEG stream proxy (single upstream, fan-out to all clients)
 *   GET /api/health    — Service health check
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { request as httpRequest } from 'http';
import type { StateStore } from './state-store.js';
import type { ServiceConfig } from './config.js';
import type { AIMonitor, AILabelConfig } from './ai-monitor.js';
import { getLogger } from './logger.js';

const log = getLogger('Camera');

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
    log.warn(`Snapshot failed: ${(err as Error).message}`);
    return null;
  }
}

/** Shared snapshot fetcher — used by both REST API and Telegram */
export async function getSnapshot(config: ServiceConfig): Promise<Buffer | null> {
  if (!config.cameraEnabled) return null;
  return fetchCameraFrame(config.cameraUrl);
}

// ---- MJPEG fan-out proxy ----
// Single upstream connection to the camera, re-streamed to all connected clients.
const MJPEG_BOUNDARY = '--mjpegboundary';
const streamClients = new Set<ServerResponse>();
let upstreamActive = false;

function startMjpegUpstream(cameraUrl: string): void {
  if (upstreamActive) return;
  upstreamActive = true;

  const url = new URL(cameraUrl);
  const reqOpts = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + (url.search || ''),
    method: 'GET',
    timeout: 10_000,
  };

  log.info(`Opening upstream MJPEG stream to ${cameraUrl}`);

  const req = httpRequest(reqOpts, (upstream) => {
    let buf = Buffer.alloc(0);

    upstream.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      // Extract complete JPEG frames and broadcast
      while (true) {
        const startIdx = buf.indexOf(JPEG_START);
        if (startIdx === -1) { buf = Buffer.alloc(0); break; }
        const endIdx = buf.indexOf(JPEG_END, startIdx + 2);
        if (endIdx === -1) break; // Wait for more data

        const frame = buf.subarray(startIdx, endIdx + 2);
        buf = buf.subarray(endIdx + 2);

        // Update snapshot cache too
        cachedSnapshot = frame;
        cacheTime = Date.now();

        // Broadcast to all connected clients
        for (const client of streamClients) {
          try {
            client.write(`${MJPEG_BOUNDARY}\r\n`);
            client.write('Content-Type: image/jpeg\r\n');
            client.write(`Content-Length: ${frame.length}\r\n\r\n`);
            client.write(frame);
          } catch {
            streamClients.delete(client);
          }
        }
      }
    });

    upstream.on('end', () => {
      log.info('Upstream stream ended');
      upstreamActive = false;
      // Reconnect if there are still clients
      if (streamClients.size > 0) {
        setTimeout(() => startMjpegUpstream(cameraUrl), 2000);
      }
    });

    upstream.on('error', (err) => {
      log.warn(`Upstream error: ${err.message}`);
      upstreamActive = false;
      if (streamClients.size > 0) {
        setTimeout(() => startMjpegUpstream(cameraUrl), 5000);
      }
    });
  });

  req.on('error', (err) => {
    log.warn(`Upstream connection failed: ${err.message}`);
    upstreamActive = false;
    if (streamClients.size > 0) {
      setTimeout(() => startMjpegUpstream(cameraUrl), 5000);
    }
  });

  req.on('timeout', () => {
    log.warn('Upstream connection timed out');
    req.destroy();
    upstreamActive = false;
    if (streamClients.size > 0) {
      setTimeout(() => startMjpegUpstream(cameraUrl), 2000);
    }
  });

  req.end();
}

function addStreamClient(res: ServerResponse, config: ServiceConfig): void {
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'close',
  });

  streamClients.add(res);
  log.info(`Stream client connected (total: ${streamClients.size})`);

  res.on('close', () => {
    streamClients.delete(res);
    log.info(`Stream client disconnected (total: ${streamClients.size})`);
  });

  // Start upstream if not already running
  startMjpegUpstream(config.cameraUrl);
}

export function createRestRouter(store: StateStore, config: ServiceConfig, aiMonitor?: AIMonitor | null) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';

    // CORS headers for API routes
    if (url.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

    if (url === '/api/stream') {
      if (!config.cameraEnabled) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Camera disabled');
        return;
      }
      addStreamClient(res, config);
      return;
    }

    // Telegram config — GET (read) and POST (update progress interval)
    if (url === '/api/config/telegram') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          enabled: config.telegramEnabled,
          chatId: config.telegramChatId ? config.telegramChatId.slice(0, 4) + '...' : '',
          progressInterval: config.progressInterval,
        }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as { progressInterval?: number };
            if (typeof data.progressInterval === 'number' &&
                data.progressInterval >= 5 && data.progressInterval <= 50) {
              (config as { progressInterval: number }).progressInterval = data.progressInterval;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, progressInterval: config.progressInterval }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid progressInterval (5-50)' }));
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }
    }

    // AI label config — GET (read) POST (update) DELETE (reset to defaults)
    if (url === '/api/config/ai-labels') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          labels: aiMonitor?.getLabelConfigs() ?? [],
          enabled: config.aiEnabled && config.aiLocalEnabled,
        }));
        return;
      }
      if (req.method === 'POST') {
        if (!aiMonitor) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'AI monitor not enabled' }));
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as { labels?: AILabelConfig[] };
            if (!Array.isArray(data.labels) || data.labels.length === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'labels must be a non-empty array' }));
              return;
            }
            // Validate each label config
            for (const lc of data.labels) {
              if (!lc.label || typeof lc.label !== 'string') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Each label must have a non-empty label string' }));
                return;
              }
              if (!['ok', 'warning', 'critical'].includes(lc.severity)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid severity: ${lc.severity}` }));
                return;
              }
              if (typeof lc.warnThreshold !== 'number' || lc.warnThreshold < 0 || lc.warnThreshold > 1) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'warnThreshold must be 0-1' }));
                return;
              }
              if (typeof lc.critThreshold !== 'number' || lc.critThreshold < 0 || lc.critThreshold > 1) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'critThreshold must be 0-1' }));
                return;
              }
            }
            aiMonitor.setLabelConfigs(data.labels).then(() => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            }).catch(() => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to save' }));
            });
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }
      if (req.method === 'DELETE') {
        if (!aiMonitor) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'AI monitor not enabled' }));
          return;
        }
        aiMonitor.resetLabelConfigs().then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, labels: aiMonitor.getLabelConfigs() }));
        }).catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to reset' }));
        });
        return;
      }
    }

    // Not an API route — let ws-transport or 404 handle it
    res.writeHead(404);
    res.end('Not found');
  };
}
