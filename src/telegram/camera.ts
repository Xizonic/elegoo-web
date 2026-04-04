/**
 * Grab a single JPEG frame from the printer's MJPEG camera stream.
 * The CC2 camera serves a continuous MJPEG stream on port 8080.
 * We read until we find a complete JPEG frame (FFD8..FFD9) then return it.
 *
 * Includes a cache — the camera typically only handles one connection,
 * so rapid-fire fetches would fail. A cached frame is reused within the TTL.
 */

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

const CACHE_TTL_MS = 10_000; // reuse snapshot for 10s
let cachedSnapshot: Buffer | null = null;
let cacheTime = 0;
let fetchInFlight: Promise<Buffer | null> | null = null;

export async function fetchSnapshot(cameraUrl: string): Promise<Buffer | null> {
  // Return cached snapshot if fresh enough
  if (cachedSnapshot && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  // Serialize: if a fetch is already in progress, wait for it
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

    if (!res.ok) {
      console.warn(`[Camera] HTTP ${res.status} from ${cameraUrl}`);
      return null;
    }

    const contentType = res.headers.get('content-type') || '';

    // If it's a direct JPEG image, return as-is
    if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) {
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    }

    // MJPEG stream: read until we find a complete JPEG frame
    if (!res.body) {
      console.warn('[Camera] No response body');
      return null;
    }

    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let totalLen = 0;
    const maxBytes = 5 * 1024 * 1024; // 5MB safety limit

    try {
      while (totalLen < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        chunks.push(buf);
        totalLen += buf.length;

        // Check if we have a complete frame
        const combined = Buffer.concat(chunks);
        const startIdx = combined.indexOf(JPEG_START);
        if (startIdx === -1) continue;
        const endIdx = combined.indexOf(JPEG_END, startIdx + 2);
        if (endIdx === -1) continue;

        // Found complete JPEG frame
        reader.cancel();
        return combined.subarray(startIdx, endIdx + 2);
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    // Fallback: return whatever we got if it looks like JPEG
    if (chunks.length > 0) {
      const combined = Buffer.concat(chunks);
      if (combined[0] === 0xff && combined[1] === 0xd8) {
        return combined;
      }
    }

    console.warn('[Camera] Could not extract JPEG frame from stream');
    return null;
  } catch (err) {
    console.warn(`[Camera] Snapshot failed: ${(err as Error).message}`);
    return null;
  }
}
