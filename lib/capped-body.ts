/*
 * A request body read with a hard byte cap (2026-11-23, for app/api/seen; the
 * independent review of that day found req.text() would read a chunked body
 * with no Content-Length whole before any length check ran). No imports, so
 * it is safe anywhere.
 */

/**
 * Read at most `cap` bytes of the request body. Returns null — and cancels
 * the stream, so nothing more is pulled — as soon as the body runs past the
 * cap, whether or not it declared a Content-Length. A chunked body of any
 * size therefore costs this route at most one chunk past the cap.
 */
export async function readCappedBody(body: ReadableStream<Uint8Array> | null, cap: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
