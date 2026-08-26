// DriveStorage adapter (AGENTS.md §24). Business logic must call this
// interface only — never Google directly — so tests can swap in an in-memory
// fake. Two concrete implementations live in this file: the production
// GoogleDriveStorage (thin wrapper over DriveClient + TokenProvider) and the
// InMemoryDriveStorage used by integration/compat tests.

import { DriveClient } from "./client.ts";
import { TokenProvider } from "./oauth-token.ts";
import { DriveRootsRepository } from "../db/repositories/drive-roots.ts";
import { DriveError } from "./errors.ts";
import type { DriveLimits } from "./limits.ts";
import type { RuntimeSettingsService } from "../services/runtime-settings-service.ts";

export type DriveOperationTarget =
  | { kind: "my_drive" }
  | { kind: "shared_drive"; driveId: string };

export interface SharedDriveSummary {
  id: string;
  name: string;
  canAddChildren: boolean;
  canDownload: boolean;
  canTrashChildren: boolean;
}

export interface SharedDriveListPage {
  items: SharedDriveSummary[];
  nextPageToken: string | null;
}

const MARKER_TYPE = "drives3Type";
const MARKER_USER = "drives3UserId";

export interface DriveSourceItem {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  appProperties: Record<string, string>;
  size: number | null;
  md5Checksum: string | null;
  modifiedTime: string | null;
  version: string | null;
  canDownload: boolean;
}

export interface DriveSourcePage {
  items: DriveSourceItem[];
  nextPageToken: string | null;
}

export interface GetDriveSourceItemInput {
  userId: string;
  fileId: string;
  target?: DriveOperationTarget;
  signal?: AbortSignal;
}

export interface ListDriveChildrenInput {
  userId: string;
  parentId: string;
  pageSize: number;
  pageToken?: string;
  foldersOnly?: boolean;
  target?: DriveOperationTarget;
  signal?: AbortSignal;
}

export interface EnsureRootInput {
  userId: string;
  target?: DriveOperationTarget;
  signal?: AbortSignal;
}

export interface ListSharedDrivesInput {
  userId: string;
  pageToken?: string;
  signal?: AbortSignal;
}

export interface ValidateSharedDriveInput {
  userId: string;
  driveId: string;
  requireWrite?: boolean;
  signal?: AbortSignal;
}

export interface CreateBucketFolderInput {
  userId: string;
  parentFolderId: string;
  bucketId: string;
  bucketName: string;
  target?: DriveOperationTarget;
  signal?: AbortSignal;
}

export interface UploadObjectInput {
  userId: string;
  bucketFolderId: string;
  objectId: string;
  objectKey: string;
  bucketId: string;
  mimeType: string;
  body: ReadableStream<Uint8Array> | Uint8Array;
  target?: DriveOperationTarget;
  signal?: AbortSignal;
}

export interface UploadedObject {
  driveFileId: string;
  size: number;
  md5Hex: string | null;
}

export interface ResumableSession {
  sessionUrl: string;
}

export interface UploadResumableChunkInput {
  userId: string;
  sessionUrl: string;
  chunk: Uint8Array;
  startOffset: number;
  totalBytes: number | null;
  isFinal: boolean;
  target?: DriveOperationTarget;
  signal?: AbortSignal;
}

export interface ResumableProgress {
  committedBytes: number;
  completed: boolean;
  uploaded?: UploadedObject;
}

export interface DownloadObjectInput {
  userId: string;
  driveFileId: string;
  range?: string;
  target?: DriveOperationTarget;
  signal?: AbortSignal;
}

export interface HeadObjectInput {
  userId: string;
  driveFileId: string;
  target?: DriveOperationTarget;
  signal?: AbortSignal;
}

export interface HeadObjectResult {
  driveFileId: string;
  size: number;
  md5Hex: string | null;
  trashed: boolean;
}

export interface DeleteObjectInput {
  userId: string;
  driveFileId: string;
  mode: "trash" | "permanent";
  target?: DriveOperationTarget;
  signal?: AbortSignal;
}

export interface BeginResumableUploadInput {
  userId: string;
  bucketFolderId: string;
  objectId: string;
  objectKey: string;
  bucketId: string;
  mimeType: string;
  target?: DriveOperationTarget;
  signal?: AbortSignal;
}

export interface DriveStorage {
  listSharedDrives(input: ListSharedDrivesInput): Promise<SharedDriveListPage>;
  validateSharedDrive(input: ValidateSharedDriveInput): Promise<SharedDriveSummary | null>;
  getSourceItem(input: GetDriveSourceItemInput): Promise<DriveSourceItem | null>;
  listChildren(input: ListDriveChildrenInput): Promise<DriveSourcePage>;
  ensureUserRoot(input: EnsureRootInput): Promise<string>;
  createBucketFolder(input: CreateBucketFolderInput): Promise<string>;
  deleteFile(input: DeleteObjectInput): Promise<void>;
  uploadObject(input: UploadObjectInput): Promise<UploadedObject>;
  downloadObject(input: DownloadObjectInput): Promise<Response>;
  headObject(input: HeadObjectInput): Promise<HeadObjectResult | null>;
  beginResumableUpload(input: BeginResumableUploadInput): Promise<ResumableSession>;
  uploadResumableChunk(input: UploadResumableChunkInput): Promise<ResumableProgress>;
}

/** Production implementation backed by Google Drive REST. */
export class GoogleDriveStorage implements DriveStorage {
  constructor(
    private readonly tokens: TokenProvider,
    private readonly roots: DriveRootsRepository,
    private readonly runtimeSettings: RuntimeSettingsService,
    private readonly limits: DriveLimits | null = null,
    private readonly retryMaxAttempts = 5,
  ) {}

  private async client(userId: string, signal?: AbortSignal): Promise<DriveClient> {
    const token = await this.tokens.getAccessToken(userId, signal);
    return new DriveClient(token, this.retryMaxAttempts);
  }

  /**
   * Wraps a Drive operation with per-user API concurrency limits and a single
   * token-refresh retry on 401. The op must be idempotent; upload chunks and
   * media multipart posts are handled separately.
   */
  private async run<T>(
    userId: string,
    signal: AbortSignal | undefined,
    op: (client: DriveClient) => Promise<T>,
  ): Promise<T> {
    const slot = this.limits ? await this.limits.request(userId, signal) : null;
    try {
      try {
        return await op(await this.client(userId, signal));
      } catch (error) {
        if (error instanceof DriveError && error.tokenRevoked) {
          this.tokens.invalidate(userId);
          return await op(await this.client(userId, signal));
        }
        throw error;
      }
    } finally {
      slot?.release();
    }
  }

  private sharedContext(target?: DriveOperationTarget) {
    return target?.kind === "shared_drive" ? { driveId: target.driveId } : undefined;
  }

  private sourceItem(file: import("./client.ts").DriveFile): DriveSourceItem {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType ?? "application/octet-stream",
      trashed: !!file.trashed,
      appProperties: file.appProperties ?? {},
      size: file.size === undefined ? null : Number(file.size),
      md5Checksum: file.md5Checksum ?? null,
      modifiedTime: file.modifiedTime ?? null,
      version: file.version ?? null,
      canDownload: file.capabilities?.canDownload !== false,
    };
  }

  async getSourceItem(input: GetDriveSourceItemInput): Promise<DriveSourceItem | null> {
    const file = await this.run(input.userId, input.signal, (client) =>
      client.getFile(input.fileId, input.signal, this.sharedContext(input.target)),
    );
    return file ? this.sourceItem(file) : null;
  }

  async listChildren(input: ListDriveChildrenInput): Promise<DriveSourcePage> {
    const page = await this.run(input.userId, input.signal, (client) =>
      client.listChildren(
        input.parentId,
        input.pageSize,
        input.pageToken,
        input.foldersOnly,
        input.signal,
        this.sharedContext(input.target),
      ),
    );
    return { items: page.files.map((file) => this.sourceItem(file)), nextPageToken: page.nextPageToken };
  }

  async listSharedDrives(input: ListSharedDrivesInput): Promise<SharedDriveListPage> {
    const page = await this.run(input.userId, input.signal, (client) =>
      client.listSharedDrives(input.pageToken, input.signal),
    );
    return {
      items: page.drives.map((drive) => ({
        id: drive.id,
        name: drive.name,
        canAddChildren: !!drive.capabilities?.canAddChildren,
        canDownload: drive.capabilities?.canDownload !== false,
        canTrashChildren: !!drive.capabilities?.canTrashChildren,
      })),
      nextPageToken: page.nextPageToken,
    };
  }

  async validateSharedDrive(
    input: ValidateSharedDriveInput,
  ): Promise<SharedDriveSummary | null> {
    const drive = await this.run(input.userId, input.signal, (client) =>
      client.getSharedDrive(input.driveId, input.signal),
    );
    if (!drive) return null;
    const result = {
      id: drive.id,
      name: drive.name,
      canAddChildren: !!drive.capabilities?.canAddChildren,
      canDownload: drive.capabilities?.canDownload !== false,
      canTrashChildren: !!drive.capabilities?.canTrashChildren,
    };
    return input.requireWrite && !result.canAddChildren ? null : result;
  }

  async ensureUserRoot(input: EnsureRootInput): Promise<string> {
    const context = this.sharedContext(input.target);
    if (!context) {
      const cached = this.roots.find(input.userId);
      if (cached) return cached.drive_folder_id;
    }
    const parentId = context?.driveId;
    const markerValue = context ? `root:${context.driveId}:${input.userId}` : "root";
    const existing = await this.run(input.userId, input.signal, (client) =>
      client.findByAppProperty(
        MARKER_TYPE,
        markerValue,
        input.signal,
        context,
        parentId,
      ),
    );
    if (existing && existing.appProperties?.[MARKER_USER] === input.userId) {
      if (!context) this.roots.upsert(input.userId, existing.id);
      return existing.id;
    }
    const created = await this.run(input.userId, input.signal, (client) =>
      client.createFolder(
        this.runtimeSettings.getRootFolderName(),
        { [MARKER_TYPE]: markerValue, [MARKER_USER]: input.userId },
        parentId,
        input.signal,
        context,
      ),
    );
    if (!context) this.roots.upsert(input.userId, created.id);
    return created.id;
  }

  async createBucketFolder(input: CreateBucketFolderInput): Promise<string> {
    const folder = await this.run(input.userId, input.signal, (client) =>
      client.createFolder(
        `${input.bucketName} [${input.bucketId}]`,
        { [MARKER_TYPE]: "bucket", drives3BucketId: input.bucketId },
        input.parentFolderId,
        input.signal,
        this.sharedContext(input.target),
      ),
    );
    return folder.id;
  }

  async deleteFile(input: DeleteObjectInput): Promise<void> {
    await this.run(input.userId, input.signal, (client) =>
      input.mode === "permanent"
        ? client.deleteFile(
            input.driveFileId,
            input.signal,
            this.sharedContext(input.target),
          )
        : client.trashFile(
            input.driveFileId,
            input.signal,
            this.sharedContext(input.target),
          ),
    );
  }

  async uploadObject(input: UploadObjectInput): Promise<UploadedObject> {
    const client = await this.client(input.userId, input.signal);
    const file = await client.uploadMedia(
      {
        // Drive `name` is cosmetic — identity is appProperties.drives3ObjectId
        // below — but using the real S3 key here (not objectId) lets the
        // file be opened directly from Drive with a readable name/extension.
        name: input.objectKey,
        mimeType: input.mimeType,
        appProperties: {
          [MARKER_TYPE]: "object",
          drives3ObjectId: input.objectId,
          drives3BucketId: input.bucketId,
        },
        parentId: input.bucketFolderId,
        body: input.body,
        sharedDrive: this.sharedContext(input.target),
      },
      input.signal,
    );
    return {
      driveFileId: file.id,
      size: Number(file.size ?? 0),
      md5Hex: file.md5Checksum ?? null,
    };
  }

  async downloadObject(input: DownloadObjectInput): Promise<Response> {
    const client = await this.client(input.userId, input.signal);
    return client.downloadMedia(input.driveFileId, {
      range: input.range,
      signal: input.signal,
      sharedDrive: this.sharedContext(input.target),
    });
  }

  async headObject(input: HeadObjectInput): Promise<HeadObjectResult | null> {
    const file = await this.run(input.userId, input.signal, (client) =>
      client.getFile(
        input.driveFileId,
        input.signal,
        this.sharedContext(input.target),
      ),
    );
    if (!file) return null;
    return {
      driveFileId: file.id,
      size: Number(file.size ?? 0),
      md5Hex: file.md5Checksum ?? null,
      trashed: !!file.trashed,
    };
  }

  async beginResumableUpload(input: BeginResumableUploadInput): Promise<ResumableSession> {
    const client = await this.client(input.userId, input.signal);
    const sessionUrl = await client.beginResumableUpload(
      {
        name: input.objectKey,
        mimeType: input.mimeType,
        appProperties: {
          [MARKER_TYPE]: "object",
          drives3ObjectId: input.objectId,
          drives3BucketId: input.bucketId,
        },
        parentId: input.bucketFolderId,
        sharedDrive: this.sharedContext(input.target),
      },
      input.signal,
    );
    return { sessionUrl };
  }

  async uploadResumableChunk(input: UploadResumableChunkInput): Promise<ResumableProgress> {
    const client = await this.client(input.userId, input.signal);
    const result = await client.uploadResumableChunk(
      {
        sessionUrl: input.sessionUrl,
        chunk: input.chunk,
        startOffset: input.startOffset,
        totalBytes: input.totalBytes,
        isFinal: input.isFinal,
      },
      input.signal,
    );
    if (result.completed && result.file) {
      return {
        committedBytes: result.committedBytes,
        completed: true,
        uploaded: {
          driveFileId: result.file.id,
          size: Number(result.file.size ?? result.committedBytes),
          md5Hex: result.file.md5Checksum ?? null,
        },
      };
    }
    return { committedBytes: result.committedBytes, completed: false };
  }
}
