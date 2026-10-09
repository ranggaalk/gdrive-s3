// Backs a bucket up through rclone, to any of its backends (SFTP, WebDAV,
// OneDrive, Dropbox, ...). Each object is streamed into `rclone rcat`.
//
// The remotes come from the operator's rclone.conf and an allowlist, never
// from a dashboard user: an rclone config can run commands on this host (the
// sftp backend's `ssh` option) or write to its disk (the local backend), so
// letting users supply one would hand them the server.

import type { AppConfig } from "../config.ts";
import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import type { RcloneDestinationConfig } from "./destination-config.ts";
import { MARKER_NAME } from "./s3-sink.ts";
import {
  bucketKeyPrefix,
  DestinationUnavailableError,
  GATEWAY_AREA,
  UnstorableObjectError,
  type BackupFileInput,
  type BackupPutInput,
  type BackupSink,
  type DestinationProbe,
} from "./sink.ts";

// rclone's "fatal" exit code: retrying will not help (account suspended,
// remote misconfigured).
const EXIT_FATAL = 7;
// "Directory not found" and "file not found": for a delete, already done.
const EXIT_NOT_FOUND = [3, 4];

// The variables rclone may need. Everything else -- MASTER_ENCRYPTION_KEY,
// the Google client secret -- stays out of the child's environment.
const PASSED_ENV = /^(PATH|HOME|TMPDIR|LANG|LC_ALL|SSL_CERT_FILE|SSL_CERT_DIR|RCLONE_.*|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy)$/;

export interface RcloneSinkOptions {
  destinationId: string;
  config: RcloneDestinationConfig;
  settings: AppConfig["backupDestinations"];
  gatewayOrigin: string;
}

export class RcloneBackupSink implements BackupSink, DestinationProbe {
  readonly wantsPlaintext = true;

  constructor(private readonly options: RcloneSinkOptions) {}

  async prepare(bucket: AccessibleBucketRow): Promise<string> {
    this.assertRemoteAllowed();
    return bucketKeyPrefix(this.options.config.path, bucket.name);
  }

  async put(input: BackupPutInput): Promise<{ destinationId: string }> {
    this.assertRemoteAllowed();
    assertSafeKey(input.object.object_key);
    const target = `${this.options.config.remote}:${input.ref}${input.object.object_key}`;
    await this.rcat(target, input.object.size_bytes, input.body, input.signal);
    return { destinationId: target };
  }

  async prepareGatewayArea(): Promise<string> {
    this.assertRemoteAllowed();
    return bucketKeyPrefix(this.options.config.path, GATEWAY_AREA);
  }

  async putFile(input: BackupFileInput): Promise<{ destinationId: string }> {
    this.assertRemoteAllowed();
    const target = `${this.options.config.remote}:${input.ref}${input.name}`;
    await this.rcat(target, input.size, input.body, input.signal);
    return { destinationId: target };
  }

  async deleteFile(target: string, signal?: AbortSignal): Promise<void> {
    this.assertRemoteAllowed();
    // Only ever a path this sink returned, under the remote it was given.
    if (!target.startsWith(`${this.options.config.remote}:`)) {
      throw new Error(`refusing to delete ${target}: it is not on remote "${this.options.config.remote}"`);
    }
    await this.rclone(["deletefile", target], null, signal, [0, ...EXIT_NOT_FOUND]);
  }

  async check(signal?: AbortSignal): Promise<void> {
    this.assertRemoteAllowed();
    const { remote, path } = this.options.config;
    const marker = new TextEncoder().encode(
      JSON.stringify(
        {
          service: "drives3-backup",
          destinationId: this.options.destinationId,
          gateway: this.options.gatewayOrigin,
          layout: "<path>/<bucket>/<object key>",
          checkedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(marker);
        controller.close();
      },
    });
    await this.rcat(`${remote}:${path ? `${path}/` : ""}${MARKER_NAME}`, marker.byteLength, body, signal);
  }

  /** The allowlist is re-read on every use, so taking a remote off it stops
   *  destinations already saved against it as well as new ones. */
  private assertRemoteAllowed(): void {
    if (!this.options.settings.rcloneRemotes.includes(this.options.config.remote)) {
      throw new DestinationUnavailableError(
        `the rclone remote "${this.options.config.remote}" is no longer offered by this gateway`,
      );
    }
  }

  /** --size lets rclone upload in one go instead of spooling, and makes it
   *  check the byte count: a short or long stream fails instead of landing. */
  private rcat(target: string, size: number, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
    return this.rclone(["rcat", "--size", String(size), target], body, signal);
  }

  private async rclone(
    args: string[],
    body: ReadableStream<Uint8Array> | null,
    signal?: AbortSignal,
    okExitCodes: number[] = [0],
  ): Promise<void> {
    signal?.throwIfAborted();
    const { rcloneBinary, rcloneConfigPath } = this.options.settings;
    const cmd = [rcloneBinary, ...(rcloneConfigPath ? ["--config", rcloneConfigPath] : []), ...args];

    let proc: Bun.Subprocess<"pipe", "ignore", "pipe">;
    try {
      proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "pipe", env: childEnv() });
    } catch (error) {
      await body?.cancel().catch(() => {});
      const reason = error instanceof Error ? error.message : String(error);
      throw new DestinationUnavailableError(`could not start rclone (${rcloneBinary}): ${reason}`);
    }

    const kill = () => proc.kill();
    signal?.addEventListener("abort", kill, { once: true });
    const stderr = new Response(proc.stderr).text();
    try {
      try {
        if (body) await pump(body, proc.stdin);
        else await proc.stdin.end();
      } catch (error) {
        if (error instanceof SourceReadError) {
          // The object could not be read; rclone is still waiting for the
          // rest of it and would otherwise wait forever.
          proc.kill();
          await proc.exited;
          throw error.cause;
        }
        // rclone went away mid-stream and closed the pipe. Its exit code and
        // stderr below say why far better than the broken pipe does.
      }
      const code = await proc.exited;
      signal?.throwIfAborted();
      if (okExitCodes.includes(code)) return;
      const message = lastLine(await stderr);
      const summary = `rclone exited with code ${code}${message ? `: ${message}` : ""}`;
      if (code === EXIT_FATAL || /Failed to create file system|didn't find section in config/i.test(message)) {
        throw new DestinationUnavailableError(summary);
      }
      throw new Error(summary);
    } finally {
      signal?.removeEventListener("abort", kill);
    }
  }
}

/** The object's own bytes failed to arrive, as opposed to rclone failing. */
class SourceReadError extends Error {
  constructor(cause: unknown) {
    super("source read failed", { cause });
  }
}

async function pump(body: ReadableStream<Uint8Array>, sink: Bun.FileSink): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        throw new SourceReadError(error);
      }
      if (next.done) break;
      sink.write(next.value);
      // Waits for the pipe to drain, so a slow remote holds back the
      // download instead of the whole object queueing up in memory.
      await sink.flush();
    }
    await sink.end();
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // An empty RCLONE_CONFIG from .env would read as "no config file at all".
    if (value && PASSED_ENV.test(name)) env[name] = value;
  }
  return env;
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, 400);
}

/**
 * On a filesystem-backed remote, an empty, "." or ".." segment would land the
 * copy somewhere other than under its bucket folder -- possibly outside the
 * path the operator meant to expose. Such an object fails on its own.
 */
function assertSafeKey(key: string): void {
  if (key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new UnstorableObjectError(
      'object keys with empty, "." or ".." path segments cannot be copied to an rclone destination',
    );
  }
}
