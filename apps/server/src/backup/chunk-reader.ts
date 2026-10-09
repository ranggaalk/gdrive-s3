// Reads a byte stream in fixed-size pieces: the S3 destination needs each part
// whole before it can send it, with an exact Content-Length and Content-MD5.

export class ChunkReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private pending: Uint8Array | null = null;
  private exhausted = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /** Up to `size` bytes. Shorter only at the end of the stream, and empty
   *  once it is exhausted. */
  async read(size: number): Promise<Uint8Array> {
    const pieces: Uint8Array[] = [];
    let filled = 0;
    while (filled < size) {
      let chunk = this.pending;
      this.pending = null;
      if (!chunk) {
        if (this.exhausted) break;
        const next = await this.reader.read();
        if (next.done) {
          this.exhausted = true;
          break;
        }
        chunk = next.value;
      }
      const take = Math.min(chunk.byteLength, size - filled);
      pieces.push(take === chunk.byteLength ? chunk : chunk.subarray(0, take));
      if (take < chunk.byteLength) this.pending = chunk.subarray(take);
      filled += take;
    }
    if (pieces.length === 1) return pieces[0]!;
    return Buffer.concat(pieces, filled);
  }

  /** Stops the source, e.g. so a download slot is released after a failure. */
  async cancel(reason?: unknown): Promise<void> {
    await this.reader.cancel(reason).catch(() => {});
  }
}
