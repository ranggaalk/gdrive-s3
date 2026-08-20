// Fault-injecting DriveStorage decorator (AGENTS.md §23). Wraps any
// `DriveStorage` implementation and applies a per-operation fault plan built
// out of the same `DriveError` categories the production classifier emits.
// The adapter is only wired in when explicitly requested; it is never used
// in production.

import { DriveError, type DriveErrorCategory } from "./errors.ts";
import type {
  BeginResumableUploadInput,
  CreateBucketFolderInput,
  DeleteObjectInput,
  DownloadObjectInput,
  DriveStorage,
  EnsureRootInput,
  HeadObjectInput,
  HeadObjectResult,
  GetDriveSourceItemInput,
  ListDriveChildrenInput,
  DriveSourceItem,
  DriveSourcePage,
  ListSharedDrivesInput,
  SharedDriveListPage,
  SharedDriveSummary,
  ValidateSharedDriveInput,
  ResumableProgress,
  ResumableSession,
  UploadObjectInput,
  UploadResumableChunkInput,
  UploadedObject,
} from "./storage.ts";

export type FaultKind =
  | "rate_limit_429"
  | "rate_limit_403"
  | "quota_403"
  | "server_500"
  | "network"
  | "not_found"
  | "token_revoked";

type OpName = keyof DriveStorage;

export interface FaultRule {
  /** Trigger only after this many successful calls; defaults to 0. */
  after?: number;
  /** Number of consecutive failures to raise before healing; defaults to 1. */
  count?: number;
}

export type FaultPlan = Partial<Record<OpName, { kind: FaultKind } & FaultRule>>;

interface OpState {
  calls: number;
  remaining: number;
}

/**
 * Wraps a DriveStorage. Each recorded op's `after`+`count` defines a strict
 * window during which the adapter throws a matching DriveError; outside the
 * window it forwards to the inner storage untouched.
 */
export class FaultInjectingDriveStorage implements DriveStorage {
  private state = new Map<OpName, OpState>();

  constructor(
    private readonly inner: DriveStorage,
    private readonly plan: FaultPlan,
  ) {}

  private tick(op: OpName): DriveError | null {
    const rule = this.plan[op];
    if (!rule) return null;
    const state = this.state.get(op) ?? { calls: 0, remaining: rule.count ?? 1 };
    state.calls += 1;
    if (state.calls <= (rule.after ?? 0)) {
      this.state.set(op, state);
      return null;
    }
    if (state.remaining <= 0) {
      this.state.set(op, state);
      return null;
    }
    state.remaining -= 1;
    this.state.set(op, state);
    return buildError(rule.kind);
  }

  private async invoke<T>(op: OpName, run: () => Promise<T>): Promise<T> {
    const failure = this.tick(op);
    if (failure) throw failure;
    return run();
  }

  listSharedDrives(input: ListSharedDrivesInput): Promise<SharedDriveListPage> {
    return this.invoke("listSharedDrives", () => this.inner.listSharedDrives(input));
  }

  validateSharedDrive(input: ValidateSharedDriveInput): Promise<SharedDriveSummary | null> {
    return this.invoke("validateSharedDrive", () => this.inner.validateSharedDrive(input));
  }

  getSourceItem(input: GetDriveSourceItemInput): Promise<DriveSourceItem | null> {
    return this.invoke("getSourceItem", () => this.inner.getSourceItem(input));
  }

  listChildren(input: ListDriveChildrenInput): Promise<DriveSourcePage> {
    return this.invoke("listChildren", () => this.inner.listChildren(input));
  }

  ensureUserRoot(input: EnsureRootInput): Promise<string> {
    return this.invoke("ensureUserRoot", () => this.inner.ensureUserRoot(input));
  }

  createBucketFolder(input: CreateBucketFolderInput): Promise<string> {
    return this.invoke("createBucketFolder", () => this.inner.createBucketFolder(input));
  }

  deleteFile(input: DeleteObjectInput): Promise<void> {
    return this.invoke("deleteFile", () => this.inner.deleteFile(input));
  }

  async uploadObject(input: UploadObjectInput): Promise<UploadedObject> {
    return this.invoke("uploadObject", () => this.inner.uploadObject(input));
  }

  async downloadObject(input: DownloadObjectInput): Promise<Response> {
    return this.invoke("downloadObject", () => this.inner.downloadObject(input));
  }

  async headObject(input: HeadObjectInput): Promise<HeadObjectResult | null> {
    const rule = this.plan.headObject;
    if (rule?.kind === "not_found") {
      const failure = this.tick("headObject");
      if (failure) return null;
      return this.inner.headObject(input);
    }
    return this.invoke("headObject", () => this.inner.headObject(input));
  }

  async beginResumableUpload(input: BeginResumableUploadInput): Promise<ResumableSession> {
    return this.invoke("beginResumableUpload", () => this.inner.beginResumableUpload(input));
  }

  async uploadResumableChunk(input: UploadResumableChunkInput): Promise<ResumableProgress> {
    return this.invoke("uploadResumableChunk", () => this.inner.uploadResumableChunk(input));
  }
}

function buildError(kind: FaultKind): DriveError {
  const spec = ERROR_SPECS[kind];
  return new DriveError(spec);
}

const ERROR_SPECS: Record<
  FaultKind,
  {
    status: number;
    category: DriveErrorCategory;
    message: string;
    reason?: string;
    retryAfterMs?: number;
    retryable?: boolean;
    tokenRevoked?: boolean;
  }
> = {
  rate_limit_429: {
    status: 429,
    category: "rate_limit",
    message: "Drive throttled (429)",
    retryAfterMs: 100,
    retryable: true,
  },
  rate_limit_403: {
    status: 403,
    category: "rate_limit",
    message: "Drive rate limited (rateLimitExceeded)",
    reason: "rateLimitExceeded",
    retryAfterMs: 100,
    retryable: true,
  },
  quota_403: {
    status: 403,
    category: "quota_exceeded",
    message: "Drive quota exceeded (storageQuotaExceeded)",
    reason: "storageQuotaExceeded",
  },
  server_500: {
    status: 500,
    category: "server_error",
    message: "Drive server error (500)",
    retryable: true,
    retryAfterMs: 50,
  },
  network: {
    status: 0,
    category: "network",
    message: "network reset",
    retryable: true,
    retryAfterMs: 50,
  },
  not_found: {
    status: 404,
    category: "not_found",
    message: "Drive resource not found",
  },
  token_revoked: {
    status: 401,
    category: "unauthorized",
    message: "Drive token revoked",
    tokenRevoked: true,
  },
};
