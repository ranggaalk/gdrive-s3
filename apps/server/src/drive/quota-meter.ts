// Observed Drive API usage. Every HTTP call this gateway makes to Google is
// counted here as it happens, so the numbers are measured rather than
// estimated. Google returns no rate-limit headers on Drive responses, so this
// is the only usage signal available without a second credential — see
// quota-probe.ts for the authoritative project-wide figures.
//
// Memory is bounded: fixed-size ring buffers, an LRU-capped per-user map, and
// a short log of throttle events. Nothing is written to the database.

export type DriveCallKind = "api" | "upload" | "download";

export interface DriveCallRecord {
  userId: string | null;
  kind: DriveCallKind;
  status: number;
  /** Google rejected the call for rate/quota reasons (403 rateLimit*, 429). */
  throttled: boolean;
  /** Reason string from the error body, when Google supplied one. */
  reason: string | null;
  retryAfterMs: number | null;
  atMs?: number;
}

export interface DriveWindowUsage {
  windowSeconds: number;
  requests: number;
  throttled: number;
  errors: number;
  byKind: Record<DriveCallKind, number>;
  /** Requests per minute implied by this window, for comparison with quotas. */
  perMinute: number;
}

export interface DriveThrottleEvent {
  at: string;
  userId: string | null;
  kind: DriveCallKind;
  status: number;
  reason: string | null;
  retryAfterMs: number | null;
}

export interface DriveUserUsage {
  userId: string;
  requestsLastHour: number;
  throttledLastHour: number;
  lastCallAt: string;
}

export interface DriveObservedUsage {
  /** When the meter started counting; windows before this are incomplete. */
  since: string;
  totalRequests: number;
  totalThrottled: number;
  windows: DriveWindowUsage[];
  recentThrottles: DriveThrottleEvent[];
  users: DriveUserUsage[];
  usersTracked: number;
}

const SECOND_SLOTS = 600; // 10 minutes of per-second resolution
const MINUTE_SLOTS = 1440; // 24 hours of per-minute resolution
const USER_MINUTE_SLOTS = 60; // 1 hour per tracked user
const MAX_TRACKED_USERS = 200;
const MAX_THROTTLE_EVENTS = 50;

/** Windows reported by default. 60s and 100s are the two periods Google's own
 *  Drive quotas are expressed in; the longer ones are for trend context. */
const DEFAULT_WINDOWS = [60, 100, 600, 3600, 86_400] as const;

interface Slot {
  stamp: number; // epoch second (or minute) this slot holds; -1 when unused
  requests: number;
  throttled: number;
  errors: number;
  api: number;
  upload: number;
  download: number;
}

function emptySlot(): Slot {
  return { stamp: -1, requests: 0, throttled: 0, errors: 0, api: 0, upload: 0, download: 0 };
}

function makeRing(size: number): Slot[] {
  return Array.from({ length: size }, emptySlot);
}

/** Reset a slot in place when the ring wraps onto a new time bucket. */
function rollSlot(slot: Slot, stamp: number): void {
  slot.stamp = stamp;
  slot.requests = 0;
  slot.throttled = 0;
  slot.errors = 0;
  slot.api = 0;
  slot.upload = 0;
  slot.download = 0;
}

function addTo(slot: Slot, record: DriveCallRecord): void {
  slot.requests++;
  if (record.throttled) slot.throttled++;
  else if (record.status >= 400 || record.status === 0) slot.errors++;
  slot[record.kind]++;
}

interface UserEntry {
  ring: Slot[];
  lastCallMs: number;
}

export class DriveQuotaMeter {
  private readonly seconds = makeRing(SECOND_SLOTS);
  private readonly minutes = makeRing(MINUTE_SLOTS);
  private readonly users = new Map<string, UserEntry>();
  private readonly throttles: DriveThrottleEvent[] = [];
  private totalRequests = 0;
  private totalThrottled = 0;
  private readonly startedAtMs: number;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAtMs = now();
  }

  record(input: DriveCallRecord): void {
    const atMs = input.atMs ?? this.now();
    const record: DriveCallRecord = { ...input, atMs };

    this.totalRequests++;
    if (record.throttled) this.totalThrottled++;

    this.write(this.seconds, Math.floor(atMs / 1000), record);
    this.write(this.minutes, Math.floor(atMs / 60_000), record);

    if (record.userId) this.writeUser(record.userId, atMs, record);

    if (record.throttled) {
      this.throttles.push({
        at: new Date(atMs).toISOString(),
        userId: record.userId,
        kind: record.kind,
        status: record.status,
        reason: record.reason,
        retryAfterMs: record.retryAfterMs,
      });
      if (this.throttles.length > MAX_THROTTLE_EVENTS) this.throttles.shift();
    }
  }

  private write(ring: Slot[], stamp: number, record: DriveCallRecord): void {
    const slot = ring[stamp % ring.length]!;
    if (slot.stamp !== stamp) rollSlot(slot, stamp);
    addTo(slot, record);
  }

  private writeUser(userId: string, atMs: number, record: DriveCallRecord): void {
    let entry = this.users.get(userId);
    if (!entry) {
      // Bound memory: evict the least recently active user once full. The
      // evicted user reappears in the map on their next call.
      if (this.users.size >= MAX_TRACKED_USERS) this.evictOldestUser();
      entry = { ring: makeRing(USER_MINUTE_SLOTS), lastCallMs: atMs };
      this.users.set(userId, entry);
    }
    entry.lastCallMs = atMs;
    this.write(entry.ring, Math.floor(atMs / 60_000), record);
  }

  private evictOldestUser(): void {
    let oldestId: string | null = null;
    let oldestMs = Infinity;
    for (const [id, entry] of this.users) {
      if (entry.lastCallMs < oldestMs) {
        oldestMs = entry.lastCallMs;
        oldestId = id;
      }
    }
    if (oldestId !== null) this.users.delete(oldestId);
  }

  snapshot(windowsSeconds: readonly number[] = DEFAULT_WINDOWS): DriveObservedUsage {
    const nowMs = this.now();
    return {
      since: new Date(this.startedAtMs).toISOString(),
      totalRequests: this.totalRequests,
      totalThrottled: this.totalThrottled,
      windows: windowsSeconds.map((seconds) => this.window(seconds, nowMs)),
      recentThrottles: [...this.throttles].reverse(),
      users: this.userUsage(nowMs),
      usersTracked: this.users.size,
    };
  }

  private window(windowSeconds: number, nowMs: number): DriveWindowUsage {
    // Sub-10-minute windows read the per-second ring for exactness; longer
    // ones read per-minute slots, which is why they are minute-aligned.
    const useSeconds = windowSeconds <= SECOND_SLOTS;
    const ring = useSeconds ? this.seconds : this.minutes;
    const unitMs = useSeconds ? 1000 : 60_000;
    const units = Math.max(1, Math.ceil((windowSeconds * 1000) / unitMs));
    const newest = Math.floor(nowMs / unitMs);
    const oldest = newest - units + 1;

    const totals: DriveWindowUsage = {
      windowSeconds,
      requests: 0,
      throttled: 0,
      errors: 0,
      byKind: { api: 0, upload: 0, download: 0 },
      perMinute: 0,
    };

    for (const slot of ring) {
      if (slot.stamp < oldest || slot.stamp > newest) continue;
      totals.requests += slot.requests;
      totals.throttled += slot.throttled;
      totals.errors += slot.errors;
      totals.byKind.api += slot.api;
      totals.byKind.upload += slot.upload;
      totals.byKind.download += slot.download;
    }

    totals.perMinute = Math.round((totals.requests / windowSeconds) * 60 * 100) / 100;
    return totals;
  }

  private userUsage(nowMs: number): DriveUserUsage[] {
    const newestMinute = Math.floor(nowMs / 60_000);
    const oldestMinute = newestMinute - USER_MINUTE_SLOTS + 1;
    const rows: DriveUserUsage[] = [];

    for (const [userId, entry] of this.users) {
      let requests = 0;
      let throttled = 0;
      for (const slot of entry.ring) {
        if (slot.stamp < oldestMinute || slot.stamp > newestMinute) continue;
        requests += slot.requests;
        throttled += slot.throttled;
      }
      if (requests === 0) continue;
      rows.push({
        userId,
        requestsLastHour: requests,
        throttledLastHour: throttled,
        lastCallAt: new Date(entry.lastCallMs).toISOString(),
      });
    }

    rows.sort((a, b) => b.requestsLastHour - a.requestsLastHour || a.userId.localeCompare(b.userId));
    return rows;
  }
}
