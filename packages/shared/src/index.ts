// Shared types & envelope contracts between server and web.

export interface ApiEnvelope<T> {
  data: T;
  requestId: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
  requestId: string;
}

export interface MeResponse {
  id: string;
  email: string;
  displayName: string | null;
  hostedDomain: string;
}

export interface DriveStatusResponse {
  connected: boolean;
  lastRefreshAt: string | null;
  lastError: string | null;
}

export type BucketStatus = "creating" | "active" | "deleting" | "error";

export interface BucketSummary {
  id: string;
  name: string;
  region: string;
  status: BucketStatus;
  createdAt: string;
  objectCount?: number;
  multipartOpen?: number;
}

export type CompatStatus = "supported" | "unsupported" | "untested";
export type CompatSource = "aws-sdk" | "aws-cli" | "rclone" | "mc" | "unit";

export interface CompatibilityItem {
  feature: string;
  status: CompatStatus;
  verifiedBy?: CompatSource[];
  notes?: string;
}

export interface GatewayStatusResponse {
  multipartOpen: number;
  compatibility: CompatibilityItem[];
}

export type ObjectStatus =
  | "active"
  | "missing"
  | "externally_modified"
  | "deleting"
  | "error";

export interface HealthResponse {
  status: "ok" | "degraded";
  checks: Record<string, boolean>;
}
