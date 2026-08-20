// HTTP byte-range parsing (AGENTS.md §13). Multi-range requests are rejected;
// unsatisfiable ranges surface as S3 InvalidRange.

import { S3Error } from "./errors.ts";

export interface ResolvedRange {
  start: number;
  end: number;
  length: number;
  totalSize: number;
  headerValue: string; // canonical single-range header to forward upstream
}

export function parseRange(header: string | null, totalSize: number): ResolvedRange | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bytes=")) return null;
  const spec = trimmed.slice("bytes=".length);
  if (spec.includes(",")) throw new S3Error("NotImplemented");

  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return unsatisfiable(totalSize);
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (startRaw === "" && endRaw === "") return unsatisfiable(totalSize);
  if (totalSize <= 0) return unsatisfiable(totalSize);

  let start: number;
  let end: number;
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return unsatisfiable(totalSize);
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? totalSize - 1 : Number(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return unsatisfiable(totalSize);
    if (start < 0 || end < 0 || start >= totalSize || start > end) return unsatisfiable(totalSize);
    end = Math.min(end, totalSize - 1);
  }
  return {
    start,
    end,
    length: end - start + 1,
    totalSize,
    headerValue: `bytes=${start}-${end}`,
  };
}

function unsatisfiable(totalSize: number): never {
  throw new S3Error("InvalidRange", { ContentRange: `bytes */${totalSize}` });
}
