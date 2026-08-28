// S3-style errors (AGENTS.md §12). Every failure the S3 router returns to a
// client must land here so the wire shape stays consistent.

import { tag, xmlDocument, xmlResponse } from "./xml.ts";
import { DriveError } from "../drive/errors.ts";

interface CodeSpec {
  status: number;
  message: string;
}

const CODES = {
  InvalidAccessKeyId: { status: 403, message: "The AWS access key id you provided is not valid." },
  SignatureDoesNotMatch: {
    status: 403,
    message: "The request signature we calculated does not match the signature you provided.",
  },
  AccessDenied: { status: 403, message: "Access denied." },
  InvalidToken: { status: 403, message: "The provided token is malformed or invalid." },
  RequestTimeTooSkewed: {
    status: 403,
    message: "The difference between the request time and the current time is too large.",
  },
  NoSuchBucket: { status: 404, message: "The specified bucket does not exist." },
  NoSuchKey: { status: 404, message: "The specified key does not exist." },
  NoSuchUpload: { status: 404, message: "The specified multipart upload does not exist." },
  BucketAlreadyOwnedByYou: {
    status: 409,
    message: "Your previous request to create the named bucket succeeded and you already own it.",
  },
  BucketNotEmpty: { status: 409, message: "The bucket you tried to delete is not empty." },
  InvalidBucketName: { status: 400, message: "The specified bucket is not valid." },
  InvalidRange: { status: 416, message: "The requested range is not satisfiable." },
  PreconditionFailed: { status: 412, message: "At least one of the preconditions did not hold." },
  InvalidPart: { status: 400, message: "One or more of the specified parts could not be found." },
  InvalidPartOrder: { status: 400, message: "The list of parts was not in ascending order." },
  AuthorizationQueryParametersError: {
    status: 400,
    message: "Presigned request has invalid or expired authorization parameters.",
  },
  InvalidRequest: { status: 400, message: "Invalid request." },
  MalformedACLError: {
    status: 400,
    message: "The ACL you provided was not well formed or did not validate against the schema.",
  },
  MalformedPolicy: { status: 400, message: "The policy you provided was not well formed." },
  NoSuchBucketPolicy: { status: 404, message: "The bucket policy does not exist." },
  NoSuchVersion: {
    status: 404,
    message: "The specified version does not exist.",
  },
  MalformedXML: {
    status: 400,
    message: "The XML you provided was not well formed or did not validate against the schema.",
  },
  ServerSideEncryptionConfigurationNotFoundError: {
    status: 404,
    message: "The server side encryption configuration was not found.",
  },
  InvalidArgument: { status: 400, message: "Invalid argument." },
  EntityTooLarge: { status: 400, message: "Your proposed upload exceeds the maximum allowed size." },
  EntityTooSmall: { status: 400, message: "Your proposed upload is smaller than the minimum allowed size." },
  MethodNotAllowed: { status: 405, message: "The specified method is not allowed against this resource." },
  NotImplemented: { status: 501, message: "A header or parameter you provided implies functionality that is not implemented." },
  ServiceUnavailable: { status: 503, message: "Service is unavailable. Please retry." },
  SlowDown: { status: 503, message: "Please reduce your request rate." },
  InternalError: { status: 500, message: "We encountered an internal error." },
} satisfies Record<string, CodeSpec>;

export type S3ErrorCode = keyof typeof CODES;

export class S3Error extends Error {
  public readonly code: S3ErrorCode;
  public readonly status: number;
  public readonly details: Record<string, string>;
  constructor(code: S3ErrorCode, details: Record<string, string> = {}) {
    super(CODES[code].message);
    this.name = "S3Error";
    this.code = code;
    this.status = CODES[code].status;
    this.details = details;
  }
}

/**
 * Convert a DriveError bubbled up from the storage adapter into a stable S3
 * wire error. Used by the router catch and by write handlers that want to
 * surface quota/rate-limit failures instead of relying on the fallback
 * InternalError branch.
 */
export function driveErrorToS3Error(error: DriveError): S3Error {
  switch (error.category) {
    case "quota_exceeded":
      return new S3Error("ServiceUnavailable");
    case "rate_limit":
      return new S3Error("SlowDown");
    case "not_found":
      return new S3Error("NoSuchKey");
    case "unauthorized":
      return new S3Error("AccessDenied");
    case "forbidden":
      return new S3Error("AccessDenied");
    case "server_error":
    case "network":
      return new S3Error("ServiceUnavailable");
    case "conflict":
      return new S3Error("InvalidRequest", { Reason: "Drive reported a conflict." });
    case "invalid_request":
      return new S3Error("InvalidRequest", { Reason: "Drive rejected the request." });
    case "aborted":
      return new S3Error("InvalidRequest", { Reason: "Drive request aborted." });
    case "other":
    default:
      return new S3Error("InternalError");
  }
}

/** Serialize an S3Error to its XML response with the correct status code. */
export function s3ErrorResponse(err: S3Error, requestId: string, hostId = ""): Response {
  const extra = Object.entries(err.details)
    .map(([k, v]) => tag(k, v))
    .join("");
  const body = xmlDocument(
    "Error",
    tag("Code", err.code) +
      tag("Message", err.message) +
      extra +
      tag("RequestId", requestId) +
      (hostId ? tag("HostId", hostId) : ""),
    false,
  );
  const headers: Record<string, string> = { "x-amz-request-id": requestId };
  if (err.code === "InvalidRange" && err.details.ContentRange) {
    headers["Content-Range"] = err.details.ContentRange;
  }
  return xmlResponse(body, err.status, headers);
}
