// Minimal Google Drive REST client (AGENTS.md §8, §21). Handles retry with
// exponential backoff + jitter for 429/5xx/rateLimitExceeded, honors Retry-After.
// Only the pieces needed for Milestone 2 (folder ensure/find) live here; object
// upload/download arrive in later milestones behind the DriveStorage adapter.

import { classifyDriveResponse, DriveError } from "./errors.ts";
import { withDriveRetry } from "./retry.ts";

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_DRIVES = "https://www.googleapis.com/drive/v3/drives";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_ABOUT = "https://www.googleapis.com/drive/v3/about";
const APP_FOLDER_MIME = "application/vnd.google-apps.folder";

export type DriveFetch = typeof fetch;

export interface SharedDrive {
  id: string;
  name: string;
  capabilities?: {
    canAddChildren?: boolean;
    canDownload?: boolean;
    canTrashChildren?: boolean;
  };
}

export interface SharedDrivePage {
  drives: SharedDrive[];
  nextPageToken: string | null;
}

export interface SharedDriveContext {
  driveId: string;
}

/** Live storage quota for the account behind the current access token. Byte
 *  counts arrive as decimal strings; `limit` is absent on unlimited accounts. */
export interface DriveStorageQuota {
  limitBytes: number | null;
  usageBytes: number;
  usageInDriveBytes: number;
  usageInDriveTrashBytes: number;
  emailAddress: string | null;
}

export interface DriveFilePage {
  files: DriveFile[];
  nextPageToken: string | null;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
  size?: string;
  md5Checksum?: string;
  driveId?: string;
  parents?: string[];
  modifiedTime?: string;
  version?: string;
  capabilities?: {
    canAddChildren?: boolean;
    canDownload?: boolean;
    canTrash?: boolean;
    canDelete?: boolean;
  };
}

interface RequestOptions {
  method: string;
  path?: string; // appended to DRIVE_FILES
  query?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

export class DriveClient {
  constructor(
    private readonly accessToken: string,
    private readonly retryMaxAttempts = 5,
    private readonly fetcher: DriveFetch = fetch,
  ) {}

  private sharedQuery(context?: SharedDriveContext): Record<string, string> {
    return context ? { supportsAllDrives: "true" } : {};
  }

  /** JSON metadata operations are idempotent at this layer and may retry. */
  private async request<T>(opts: RequestOptions): Promise<T> {
    const url = new URL(`${DRIVE_FILES}${opts.path ?? ""}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    return withDriveRetry(
      async () => {
        let res: Response;
        try {
          res = await this.fetcher(url, {
            method: opts.method,
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              ...(opts.body ? { "Content-Type": "application/json" } : {}),
            },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            signal: opts.signal,
          });
        } catch (error) {
          if (opts.signal?.aborted) {
            throw new DriveError({
              status: 0,
              category: "aborted",
              message: "Drive request aborted",
            });
          }
          throw new DriveError({
            status: 0,
            category: "network",
            message: error instanceof Error ? error.message : "Drive network error",
            retryable: true,
          });
        }

        if (res.ok) {
          if (res.status === 204) return undefined as T;
          return (await res.json()) as T;
        }
        const text = await res.text();
        throw classifyDriveResponse(res.status, text, res.headers.get("retry-after"));
      },
      {
        maxAttempts: opts.method === "POST" ? 1 : this.retryMaxAttempts,
        signal: opts.signal,
      },
    );
  }

  async listSharedDrives(
    pageToken?: string,
    signal?: AbortSignal,
  ): Promise<SharedDrivePage> {
    const url = new URL(DRIVE_DRIVES);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set(
      "fields",
      "nextPageToken,drives(id,name,capabilities(canAddChildren,canDownload,canTrashChildren))",
    );
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await this.fetcher(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw classifyDriveResponse(res.status, text, res.headers.get("retry-after"));
    }
    const data = (await res.json()) as {
      drives?: SharedDrive[];
      nextPageToken?: string;
    };
    return {
      drives: data.drives ?? [],
      nextPageToken: data.nextPageToken ?? null,
    };
  }

  async getSharedDrive(driveId: string, signal?: AbortSignal): Promise<SharedDrive | null> {
    const url = new URL(`${DRIVE_DRIVES}/${encodeURIComponent(driveId)}`);
    url.searchParams.set(
      "fields",
      "id,name,capabilities(canAddChildren,canDownload,canTrashChildren)",
    );
    const res = await this.fetcher(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw classifyDriveResponse(res.status, text, res.headers.get("retry-after"));
    }
    return (await res.json()) as SharedDrive;
  }

  async findByAppProperty(
    key: string,
    value: string,
    signal?: AbortSignal,
    context?: SharedDriveContext,
    parentId?: string,
  ): Promise<DriveFile | null> {
    // appProperties has key/value; escape single quotes in the value.
    const safeValue = value.replace(/'/g, "\\'");
    const q = [
      `appProperties has { key='${key}' and value='${safeValue}' }`,
      `mimeType='${APP_FOLDER_MIME}'`,
      "trashed=false",
      ...(parentId ? [`'${parentId.replace(/'/g, "\\'")}' in parents`] : []),
    ].join(" and ");
    const data = await this.request<{ files: DriveFile[] }>({
      method: "GET",
      query: {
        q,
        fields: "files(id,name,mimeType,trashed,appProperties,driveId,parents,capabilities)",
        spaces: "drive",
        pageSize: "10",
        ...(context
          ? {
              corpora: "drive",
              driveId: context.driveId,
              includeItemsFromAllDrives: "true",
              supportsAllDrives: "true",
            }
          : {}),
      },
      signal,
    });
    return data.files[0] ?? null;
  }

  async listChildren(
    parentId: string,
    pageSize: number,
    pageToken?: string,
    foldersOnly = false,
    signal?: AbortSignal,
    context?: SharedDriveContext,
  ): Promise<DriveFilePage> {
    const safeParent = parentId.replace(/'/g, "\\'");
    const q = [
      `'${safeParent}' in parents`,
      "trashed=false",
      ...(foldersOnly ? [`mimeType='${APP_FOLDER_MIME}'`] : []),
    ].join(" and ");
    const data = await this.request<{ files?: DriveFile[]; nextPageToken?: string }>({
      method: "GET",
      query: {
        q,
        fields:
          "nextPageToken,files(id,name,mimeType,trashed,appProperties,size,md5Checksum,modifiedTime,version,driveId,parents,capabilities)",
        spaces: "drive",
        pageSize: String(pageSize),
        ...(pageToken ? { pageToken } : {}),
        ...(context
          ? {
              corpora: "drive",
              driveId: context.driveId,
              includeItemsFromAllDrives: "true",
              supportsAllDrives: "true",
            }
          : {}),
      },
      signal,
    });
    return { files: data.files ?? [], nextPageToken: data.nextPageToken ?? null };
  }

  async createFolder(
    name: string,
    appProperties: Record<string, string>,
    parentId?: string,
    signal?: AbortSignal,
    context?: SharedDriveContext,
  ): Promise<DriveFile> {
    return this.request<DriveFile>({
      method: "POST",
      query: {
        fields: "id,name,mimeType,appProperties,driveId,parents,capabilities",
        ...this.sharedQuery(context),
      },
      body: {
        name,
        mimeType: APP_FOLDER_MIME,
        appProperties,
        ...(parentId ? { parents: [parentId] } : {}),
      },
      signal,
    });
  }

  /** Move a file/folder to trash (recoverable). */
  async trashFile(
    fileId: string,
    signal?: AbortSignal,
    context?: SharedDriveContext,
  ): Promise<void> {
    await this.request<DriveFile>({
      method: "PATCH",
      path: `/${encodeURIComponent(fileId)}`,
      query: { fields: "id,trashed", ...this.sharedQuery(context) },
      body: { trashed: true },
      signal,
    });
  }

  /** Permanently delete a file/folder. */
  async deleteFile(
    fileId: string,
    signal?: AbortSignal,
    context?: SharedDriveContext,
  ): Promise<void> {
    await this.request<void>({
      method: "DELETE",
      path: `/${encodeURIComponent(fileId)}`,
      query: this.sharedQuery(context),
      signal,
    });
  }

  async getFile(
    fileId: string,
    signal?: AbortSignal,
    context?: SharedDriveContext,
  ): Promise<DriveFile | null> {
    try {
      return await this.request<DriveFile>({
        method: "GET",
        path: `/${encodeURIComponent(fileId)}`,
        query: {
          fields: "id,name,mimeType,trashed,appProperties,size,md5Checksum,modifiedTime,version,driveId,parents,capabilities",
          ...this.sharedQuery(context),
        },
        signal,
      });
    } catch (err) {
      if (err instanceof DriveError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Read the account's live storage quota. This is the one quota Google
   * reports directly on a Drive call — request quotas are not exposed here
   * and must come from the Cloud Monitoring probe instead.
   */
  async getStorageQuota(signal?: AbortSignal): Promise<DriveStorageQuota> {
    const url = new URL(DRIVE_ABOUT);
    url.searchParams.set("fields", "storageQuota,user(emailAddress)");
    const res = await this.fetcher(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw classifyDriveResponse(res.status, text, res.headers.get("retry-after"));
    }
    const body = (await res.json()) as {
      storageQuota?: {
        limit?: string;
        usage?: string;
        usageInDrive?: string;
        usageInDriveTrash?: string;
      };
      user?: { emailAddress?: string };
    };
    const quota = body.storageQuota ?? {};
    return {
      limitBytes: quota.limit === undefined ? null : Number(quota.limit),
      usageBytes: Number(quota.usage ?? 0),
      usageInDriveBytes: Number(quota.usageInDrive ?? 0),
      usageInDriveTrashBytes: Number(quota.usageInDriveTrash ?? 0),
      emailAddress: body.user?.emailAddress ?? null,
    };
  }

  /**
   * Upload bytes as a new blob using Drive multipart upload. Always stored with
   * the given MIME type — never converted to a Google Docs format (AGENTS.md §8).
   * The body is streamed; do not buffer large objects into RAM.
   */
  async uploadMedia(
    input: {
      name: string;
      mimeType: string;
      appProperties: Record<string, string>;
      parentId: string;
      body: ReadableStream<Uint8Array> | Uint8Array;
      sharedDrive?: SharedDriveContext;
    },
    signal?: AbortSignal,
  ): Promise<DriveFile> {
    const boundary = `drives3-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({
      name: input.name,
      mimeType: input.mimeType,
      appProperties: input.appProperties,
      parents: [input.parentId],
    });

    const encoder = new TextEncoder();
    const preamble = encoder.encode(
      `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${metadata}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${input.mimeType}\r\n\r\n`,
    );
    const epilogue = encoder.encode(`\r\n--${boundary}--\r\n`);

    const body = multipartStream(preamble, input.body, epilogue);
    const url = new URL(DRIVE_UPLOAD);
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("fields", "id,name,mimeType,size,md5Checksum,appProperties,driveId,parents");
    if (input.sharedDrive) url.searchParams.set("supportsAllDrives", "true");

    const res = await this.fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
      // @ts-expect-error Bun/undici streaming request bodies require half duplex.
      duplex: "half",
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw classifyDriveResponse(res.status, text, res.headers.get("retry-after"));
    }
    return (await res.json()) as DriveFile;
  }

  /** Start a Google Drive resumable-upload session. Session URL is sensitive. */
  async beginResumableUpload(
    input: {
      name: string;
      mimeType: string;
      appProperties: Record<string, string>;
      parentId: string;
      sharedDrive?: SharedDriveContext;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const url = new URL(DRIVE_UPLOAD);
    url.searchParams.set("uploadType", "resumable");
    url.searchParams.set("fields", "id,name,mimeType,size,md5Checksum,appProperties,driveId,parents");
    if (input.sharedDrive) url.searchParams.set("supportsAllDrives", "true");
    const res = await this.fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": input.mimeType,
      },
      body: JSON.stringify({
        name: input.name,
        mimeType: input.mimeType,
        appProperties: input.appProperties,
        parents: [input.parentId],
      }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw classifyDriveResponse(res.status, text, res.headers.get("retry-after"));
    }
    const sessionUrl = res.headers.get("location");
    if (!sessionUrl) {
      throw new DriveError({
        status: 502,
        category: "other",
        message: "Drive resumable session did not return a Location header",
      });
    }
    return sessionUrl;
  }

  /** Upload one chunk. A 308 response reports the last committed byte. */
  async uploadResumableChunk(
    input: {
      sessionUrl: string;
      chunk: Uint8Array;
      startOffset: number;
      totalBytes: number | null;
      isFinal: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{
    committedBytes: number;
    completed: boolean;
    file?: DriveFile;
  }> {
    const end = input.startOffset + input.chunk.byteLength - 1;
    const total = input.isFinal
      ? String(input.totalBytes ?? input.startOffset + input.chunk.byteLength)
      : "*";
    const contentRange = input.chunk.byteLength === 0
      ? `bytes */${total}`
      : `bytes ${input.startOffset}-${end}/${total}`;
    const res = await this.fetcher(input.sessionUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(input.chunk.byteLength),
        "Content-Range": contentRange,
      },
      body: input.chunk,
      signal,
    });
    if (res.status === 308) {
      const range = res.headers.get("range");
      const match = /bytes=0-(\d+)/.exec(range ?? "");
      return {
        committedBytes: match ? Number(match[1]) + 1 : input.startOffset,
        completed: false,
      };
    }
    if (!res.ok) {
      const text = await res.text();
      throw classifyDriveResponse(res.status, text, res.headers.get("retry-after"));
    }
    const file = (await res.json()) as DriveFile;
    return {
      committedBytes: Number(file.size ?? input.startOffset + input.chunk.byteLength),
      completed: true,
      file,
    };
  }

  /**
   * Download object bytes via alt=media. Forwards an optional Range header and
   * returns the raw fetch Response so callers can stream it to the client.
   */
  async downloadMedia(
    fileId: string,
    opts: { range?: string; signal?: AbortSignal; sharedDrive?: SharedDriveContext } = {},
  ): Promise<Response> {
    const url = new URL(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    if (opts.sharedDrive) url.searchParams.set("supportsAllDrives", "true");
    const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    if (opts.range) headers["Range"] = opts.range;
    const res = await this.fetcher(url, { method: "GET", headers, signal: opts.signal });
    if (!res.ok && res.status !== 206) {
      const text = await res.text();
      throw classifyDriveResponse(res.status, text, res.headers.get("retry-after"));
    }
    return res;
  }
}

/** Concatenate preamble + (stream|bytes) + epilogue into one ReadableStream. */
function multipartStream(
  preamble: Uint8Array,
  body: ReadableStream<Uint8Array> | Uint8Array,
  epilogue: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(preamble);
      if (body instanceof Uint8Array) {
        controller.enqueue(body);
      } else {
        const reader = body.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      }
      controller.enqueue(epilogue);
      controller.close();
    },
  });
}
