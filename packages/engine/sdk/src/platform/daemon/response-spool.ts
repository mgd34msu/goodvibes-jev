import { mkdtemp, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Drain finite response bodies to disk so a large/slow body does not accumulate in RAM. */
export async function readResponseSpool(response: Response, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!response.body) return '';
  const directory = await mkdtemp(join(tmpdir(), 'goodvibes-response-'));
  const path = join(directory, 'body');
  let file: FileHandle | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => { void reader?.cancel(signal?.reason).catch(() => {}); };
  try {
    file = await open(path, 'wx', 0o600);
    reader = response.body.getReader();
    signal?.addEventListener('abort', abort, { once: true });
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      let offset = 0;
      while (offset < chunk.value.length) {
        signal?.throwIfAborted();
        const { bytesWritten } = await file.write(chunk.value, offset, chunk.value.length - offset);
        if (!bytesWritten) throw new Error('Response spool write did not advance');
        offset += bytesWritten;
      }
    }
    signal?.throwIfAborted();
    const text = await readFile(path, 'utf8');
    signal?.throwIfAborted();
    return text;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    try { await file?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
