// Multipart parts repository. temp_path is generated internally and must
// always be validated before use by the filesystem layer.

import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export interface MultipartPartRow {
  upload_id: string;
  part_number: number;
  temp_path: string;
  size_bytes: number;
  etag: string;
  checksum_sha256: string | null;
  created_at: string;
}

export class MultipartPartsRepository {
  constructor(private readonly db: Database) {}

  upsert(input: {
    uploadId: string;
    partNumber: number;
    tempPath: string;
    sizeBytes: number;
    etag: string;
    checksumSha256: string;
  }): MultipartPartRow {
    this.db
      .query(
        `INSERT INTO multipart_parts
           (upload_id, part_number, temp_path, size_bytes, etag,
            checksum_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(upload_id, part_number) DO UPDATE SET
           temp_path = excluded.temp_path,
           size_bytes = excluded.size_bytes,
           etag = excluded.etag,
           checksum_sha256 = excluded.checksum_sha256,
           created_at = excluded.created_at`,
      )
      .run(
        input.uploadId,
        input.partNumber,
        input.tempPath,
        input.sizeBytes,
        input.etag,
        input.checksumSha256,
        nowIso(),
      );
    return this.find(input.uploadId, input.partNumber)!;
  }

  find(uploadId: string, partNumber: number): MultipartPartRow | null {
    return (
      this.db
        .query<MultipartPartRow, [string, number]>(
          "SELECT * FROM multipart_parts WHERE upload_id = ? AND part_number = ?",
        )
        .get(uploadId, partNumber) ?? null
    );
  }

  list(uploadId: string): MultipartPartRow[] {
    return this.db
      .query<MultipartPartRow, [string]>(
        "SELECT * FROM multipart_parts WHERE upload_id = ? ORDER BY part_number ASC",
      )
      .all(uploadId);
  }

  count(uploadId: string): number {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM multipart_parts WHERE upload_id = ?",
        )
        .get(uploadId)?.n ?? 0
    );
  }

  totalSize(uploadId: string): number {
    return (
      this.db
        .query<{ n: number | null }, [string]>(
          "SELECT COALESCE(SUM(size_bytes), 0) AS n FROM multipart_parts WHERE upload_id = ?",
        )
        .get(uploadId)?.n ?? 0
    );
  }

  deleteAll(uploadId: string): MultipartPartRow[] {
    const rows = this.list(uploadId);
    this.db.query("DELETE FROM multipart_parts WHERE upload_id = ?").run(uploadId);
    return rows;
  }
}
