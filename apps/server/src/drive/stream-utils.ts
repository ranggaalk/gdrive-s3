// Wraps a Drive download body so a concurrency-limit slot is released the
// moment the stream is fully consumed or cancelled, not only when the
// consumer explicitly closes it. Shared by drive-import-service.ts and
// backup-transfer-service.ts, which both pipe a Drive download straight
// into another upload.

export function releaseWhenConsumed(
  body: ReadableStream<Uint8Array>,
  slot: { release(): void },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    slot.release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
        } else if (next.value) {
          controller.enqueue(next.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
}
