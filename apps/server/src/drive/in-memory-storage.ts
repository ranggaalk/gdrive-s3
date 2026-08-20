// In-memory DriveStorage for tests (AGENTS.md §24). Stores object bytes in a
// Map and mimics enough of Drive to exercise the S3 layer without Google.

import { createHash, randomUUID } from "node:crypto";
import type {
  DriveStorage,
  EnsureRootInput,
  CreateBucketFolderInput,
  UploadObjectInput,
  UploadedObject,
  DownloadObjectInput,
  HeadObjectInput,
  HeadObjectResult,
  DeleteObjectInput,
  BeginResumableUploadInput,
  ResumableSession,
  UploadResumableChunkInput,
  ResumableProgress,
  DriveOperationTarget,
  ListSharedDrivesInput,
  ValidateSharedDriveInput,
  GetDriveSourceItemInput,
  ListDriveChildrenInput,
  DriveSourceItem,
} from "./storage.ts";

interface StoredBlob {
  bytes: Uint8Array;
  md5Hex: string;
  trashed: boolean;
  target: DriveOperationTarget;
}

interface StoredSource extends DriveSourceItem {
  parentId: string | null;
  bytes: Uint8Array | null;
  target: DriveOperationTarget;
}

async function collect(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

interface ResumableSessionState {
  chunks: Uint8Array[];
  committed: number;
  finalized: boolean;
  bucketId: string;
  objectId: string;
  target: DriveOperationTarget;
}

export class InMemoryDriveStorage implements DriveStorage {
  private roots = new Map<string, string>();
  private blobs = new Map<string, StoredBlob>();
  private sessions = new Map<string, ResumableSessionState>();
  private sources = new Map<string, StoredSource>();
  private sharedDrives = new Map<
    string,
    { name: string; members: Map<string, { canWrite: boolean; canDelete: boolean }> }
  >();

  seedSource(input: {
    id?: string;
    parentId?: string | null;
    name: string;
    mimeType?: string;
    bytes?: Uint8Array;
    appProperties?: Record<string, string>;
    target?: DriveOperationTarget;
    canDownload?: boolean;
    modifiedTime?: string;
    version?: string;
  }): string {
    const id = input.id ?? `source_${randomUUID()}`;
    const bytes = input.bytes?.slice() ?? null;
    const target = input.target ?? { kind: "my_drive" as const };
    const md5Checksum = bytes ? createHash("md5").update(bytes).digest("hex") : null;
    this.sources.set(id, {
      id,
      parentId: input.parentId ?? (target.kind === "shared_drive" ? target.driveId : "root"),
      name: input.name,
      mimeType: input.mimeType ?? (bytes ? "application/octet-stream" : "application/vnd.google-apps.folder"),
      bytes,
      trashed: false,
      appProperties: input.appProperties ?? {},
      size: bytes?.byteLength ?? null,
      md5Checksum,
      modifiedTime: input.modifiedTime ?? new Date().toISOString(),
      version: input.version ?? "1",
      canDownload: input.canDownload ?? bytes !== null,
      target,
    });
    return id;
  }

  registerSharedDrive(input: {
    id: string;
    name: string;
    members: Array<{ userId: string; canWrite: boolean; canDelete?: boolean }>;
  }): void {
    this.sharedDrives.set(input.id, {
      name: input.name,
      members: new Map(
        input.members.map((member) => [
          member.userId,
          { canWrite: member.canWrite, canDelete: member.canDelete ?? member.canWrite },
        ]),
      ),
    });
  }

  revokeSharedDriveAccess(driveId: string, userId: string): void {
    this.sharedDrives.get(driveId)?.members.delete(userId);
  }

  async listSharedDrives(input: ListSharedDrivesInput) {
    const items = [...this.sharedDrives.entries()]
      .filter(([, drive]) => drive.members.has(input.userId))
      .map(([id, drive]) => {
        const access = drive.members.get(input.userId)!;
        return {
          id,
          name: drive.name,
          canAddChildren: access.canWrite,
          canDownload: true,
          canTrashChildren: access.canDelete,
        };
      });
    return { items, nextPageToken: null };
  }

  async validateSharedDrive(input: ValidateSharedDriveInput) {
    const drive = this.sharedDrives.get(input.driveId);
    const access = drive?.members.get(input.userId);
    if (!drive || !access || (input.requireWrite && !access.canWrite)) return null;
    return {
      id: input.driveId,
      name: drive.name,
      canAddChildren: access.canWrite,
      canDownload: true,
      canTrashChildren: access.canDelete,
    };
  }

  private assertTarget(userId: string, target?: DriveOperationTarget) {
    if (target?.kind !== "shared_drive") return;
    const access = this.sharedDrives.get(target.driveId)?.members.get(userId);
    if (!access) throw new Error("Shared Drive access denied");
  }

  private assertBlobTarget(blob: StoredBlob, target?: DriveOperationTarget): void {
    const actual = target ?? { kind: "my_drive" as const };
    if (blob.target.kind !== actual.kind) throw new Error("Drive target mismatch");
    if (
      blob.target.kind === "shared_drive" &&
      actual.kind === "shared_drive" &&
      blob.target.driveId !== actual.driveId
    ) {
      throw new Error("Shared Drive target mismatch");
    }
  }

  async getSourceItem(input: GetDriveSourceItemInput): Promise<DriveSourceItem | null> {
    this.assertTarget(input.userId, input.target);
    const source = this.sources.get(input.fileId);
    if (source) {
      this.assertSourceTarget(source, input.target);
      return sourceView(source);
    }
    if (input.fileId === "root" && input.target?.kind !== "shared_drive") {
      return rootSource("root", "My Drive");
    }
    if (input.target?.kind === "shared_drive" && input.fileId === input.target.driveId) {
      const drive = this.sharedDrives.get(input.target.driveId);
      if (drive) return rootSource(input.target.driveId, drive.name);
    }
    return null;
  }

  async listChildren(input: ListDriveChildrenInput) {
    this.assertTarget(input.userId, input.target);
    const filtered = [...this.sources.values()]
      .filter((source) => source.parentId === input.parentId && !source.trashed)
      .filter((source) => !input.foldersOnly || source.mimeType === "application/vnd.google-apps.folder")
      .filter((source) => targetMatches(source.target, input.target))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const offset = input.pageToken ? Number(input.pageToken) : 0;
    const items = filtered.slice(offset, offset + input.pageSize).map(sourceView);
    const next = offset + items.length;
    return { items, nextPageToken: next < filtered.length ? String(next) : null };
  }

  private assertSourceTarget(source: StoredSource, target?: DriveOperationTarget): void {
    if (!targetMatches(source.target, target)) throw new Error("Drive target mismatch");
  }

  async ensureUserRoot(input: EnsureRootInput): Promise<string> {
    this.assertTarget(input.userId, input.target);
    const rootKey = input.target?.kind === "shared_drive"
      ? `${input.userId}:${input.target.driveId}`
      : input.userId;
    let id = this.roots.get(rootKey);
    if (!id) {
      id = `root_${randomUUID()}`;
      this.roots.set(rootKey, id);
    }
    return id;
  }

  async createBucketFolder(input: CreateBucketFolderInput): Promise<string> {
    this.assertTarget(input.userId, input.target);
    const id = `folder_${randomUUID()}`;
    this.sources.set(id, {
      id,
      parentId: input.parentFolderId,
      name: input.bucketName,
      mimeType: "application/vnd.google-apps.folder",
      bytes: null,
      trashed: false,
      appProperties: { drives3Type: "bucket", drives3BucketId: input.bucketId },
      size: null,
      md5Checksum: null,
      modifiedTime: new Date().toISOString(),
      version: "1",
      canDownload: false,
      target: input.target ?? { kind: "my_drive" },
    });
    return id;
  }

  async deleteFile(input: DeleteObjectInput): Promise<void> {
    this.assertTarget(input.userId, input.target);
    if (input.mode === "permanent") {
      const blob = this.blobs.get(input.driveFileId);
      if (blob) this.assertBlobTarget(blob, input.target);
      this.blobs.delete(input.driveFileId);
    } else {
      const b = this.blobs.get(input.driveFileId);
      if (b) {
        this.assertBlobTarget(b, input.target);
        b.trashed = true;
      }
    }
  }

  async uploadObject(input: UploadObjectInput): Promise<UploadedObject> {
    this.assertTarget(input.userId, input.target);
    const bytes = await collect(input.body);
    const md5Hex = createHash("md5").update(bytes).digest("hex");
    const id = `file_${randomUUID()}`;
    this.blobs.set(id, {
      bytes,
      md5Hex,
      trashed: false,
      target: input.target ?? { kind: "my_drive" },
    });
    return { driveFileId: id, size: bytes.length, md5Hex };
  }

  async downloadObject(input: DownloadObjectInput): Promise<Response> {
    this.assertTarget(input.userId, input.target);
    const source = this.sources.get(input.driveFileId);
    const b = this.blobs.get(input.driveFileId);
    if (source) {
      this.assertSourceTarget(source, input.target);
      if (source.trashed || !source.bytes || !source.canDownload) {
        return new Response(null, { status: 404 });
      }
      return byteResponse(source.bytes, input.range);
    }
    if (!b || b.trashed) return new Response(null, { status: 404 });
    this.assertBlobTarget(b, input.target);

    if (input.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(input.range);
      if (m) {
        const total = b.bytes.length;
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        const slice = b.bytes.slice(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Content-Length": String(slice.length),
          },
        });
      }
    }
    return new Response(b.bytes, {
      status: 200,
      headers: { "Content-Length": String(b.bytes.length) },
    });
  }

  async headObject(input: HeadObjectInput): Promise<HeadObjectResult | null> {
    this.assertTarget(input.userId, input.target);
    const b = this.blobs.get(input.driveFileId);
    if (!b) return null;
    this.assertBlobTarget(b, input.target);
    return { driveFileId: input.driveFileId, size: b.bytes.length, md5Hex: b.md5Hex, trashed: b.trashed };
  }

  async beginResumableUpload(input: BeginResumableUploadInput): Promise<ResumableSession> {
    this.assertTarget(input.userId, input.target);
    const id = `mem-session-${randomUUID()}`;
    this.sessions.set(id, {
      chunks: [],
      committed: 0,
      finalized: false,
      bucketId: input.bucketId,
      objectId: input.objectId,
      target: input.target ?? { kind: "my_drive" },
    });
    return { sessionUrl: id };
  }

  async uploadResumableChunk(input: UploadResumableChunkInput): Promise<ResumableProgress> {
    this.assertTarget(input.userId, input.target);
    const session = this.sessions.get(input.sessionUrl);
    if (!session || session.finalized) throw new Error("invalid resumable session");
    const target = input.target ?? { kind: "my_drive" as const };
    if (
      session.target.kind !== target.kind ||
      (session.target.kind === "shared_drive" &&
        target.kind === "shared_drive" &&
        session.target.driveId !== target.driveId)
    ) {
      throw new Error("resumable target mismatch");
    }
    if (input.startOffset !== session.committed) {
      return { committedBytes: session.committed, completed: false };
    }
    session.chunks.push(input.chunk.slice());
    session.committed += input.chunk.byteLength;
    if (!input.isFinal) {
      return { committedBytes: session.committed, completed: false };
    }

    const bytes = concatChunks(session.chunks, session.committed);
    const md5Hex = createHash("md5").update(bytes).digest("hex");
    const driveFileId = `file_${randomUUID()}`;
    this.blobs.set(driveFileId, {
      bytes,
      md5Hex,
      trashed: false,
      target: session.target,
    });
    session.finalized = true;
    this.sessions.delete(input.sessionUrl);
    return {
      committedBytes: session.committed,
      completed: true,
      uploaded: { driveFileId, size: bytes.length, md5Hex },
    };
  }
}

function targetMatches(actual: DriveOperationTarget, expected?: DriveOperationTarget): boolean {
  const target = expected ?? { kind: "my_drive" as const };
  return actual.kind === target.kind &&
    (actual.kind !== "shared_drive" ||
      (target.kind === "shared_drive" && actual.driveId === target.driveId));
}

function sourceView(source: StoredSource): DriveSourceItem {
  return {
    id: source.id,
    name: source.name,
    mimeType: source.mimeType,
    trashed: source.trashed,
    appProperties: { ...source.appProperties },
    size: source.size,
    md5Checksum: source.md5Checksum,
    modifiedTime: source.modifiedTime,
    version: source.version,
    canDownload: source.canDownload,
  };
}

function rootSource(id: string, name: string): DriveSourceItem {
  return {
    id,
    name,
    mimeType: "application/vnd.google-apps.folder",
    trashed: false,
    appProperties: {},
    size: null,
    md5Checksum: null,
    modifiedTime: null,
    version: null,
    canDownload: false,
  };
}

function byteResponse(bytes: Uint8Array, range?: string): Response {
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
      const slice = bytes.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
          "Content-Length": String(slice.length),
        },
      });
    }
  }
  return new Response(bytes, { status: 200, headers: { "Content-Length": String(bytes.length) } });
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
