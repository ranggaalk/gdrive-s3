// When a backup schedule falls due next. Pure: no clock, no database, so the
// awkward cases -- a time that a DST change skips or repeats, a week that
// wraps -- can be tested directly.
//
// Wall-clock times are read in the schedule's own IANA time zone through Intl,
// which Bun ships with full time zone data; no date library needed.

export type ScheduleFrequency = "interval" | "daily" | "weekly";

export interface ScheduleTiming {
  frequency: ScheduleFrequency;
  /** "interval" only. */
  intervalMinutes: number | null;
  /** "daily" and "weekly": "HH:MM" on the schedule's wall clock. */
  timeOfDay: string | null;
  /** "weekly" only: ISO weekdays, 1 = Monday ... 7 = Sunday. */
  daysOfWeek: number[] | null;
  timezone: string;
}

export class ScheduleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleInputError";
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Checks a timing and drops the fields its frequency does not use. */
export function normalizeTiming(input: ScheduleTiming, minIntervalMinutes: number): ScheduleTiming {
  if (!isValidTimeZone(input.timezone)) {
    throw new ScheduleInputError(`"${input.timezone}" is not a time zone name such as Asia/Jakarta`);
  }
  if (input.frequency === "interval") {
    const minutes = input.intervalMinutes;
    if (minutes === null || !Number.isInteger(minutes) || minutes < minIntervalMinutes || minutes > MAX_INTERVAL_MINUTES) {
      throw new ScheduleInputError(
        `intervalMinutes must be a whole number from ${minIntervalMinutes} to ${MAX_INTERVAL_MINUTES}`,
      );
    }
    return { frequency: "interval", intervalMinutes: minutes, timeOfDay: null, daysOfWeek: null, timezone: input.timezone };
  }
  if (input.frequency !== "daily" && input.frequency !== "weekly") {
    throw new ScheduleInputError('frequency must be "interval", "daily" or "weekly"');
  }
  if (!input.timeOfDay || !TIME_PATTERN.test(input.timeOfDay)) {
    throw new ScheduleInputError('timeOfDay must be a 24-hour "HH:MM" time');
  }
  if (input.frequency === "daily") {
    return { frequency: "daily", intervalMinutes: null, timeOfDay: input.timeOfDay, daysOfWeek: null, timezone: input.timezone };
  }
  const days = [...new Set(input.daysOfWeek ?? [])].sort((a, b) => a - b);
  if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new ScheduleInputError("daysOfWeek must list at least one ISO weekday, 1 (Monday) to 7 (Sunday)");
  }
  return { frequency: "weekly", intervalMinutes: null, timeOfDay: input.timeOfDay, daysOfWeek: days, timezone: input.timezone };
}

/** The first moment strictly after `after` that the schedule falls due. */
export function nextRunAt(timing: ScheduleTiming, after: Date): Date {
  if (timing.frequency === "interval") {
    return new Date(after.getTime() + timing.intervalMinutes! * MINUTE_MS);
  }
  const [hour, minute] = timing.timeOfDay!.split(":").map(Number) as [number, number];
  const today = wallClock(after, timing.timezone);
  // Eight days covers every weekly pattern, including "only today's
  // weekday, but today's time has passed".
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const isoWeekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (timing.frequency === "weekly" && !timing.daysOfWeek!.includes(isoWeekday)) continue;
    const candidate = zonedTimeToInstant(
      { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute },
      timing.timezone,
    );
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("no upcoming run within eight days"); // unreachable for a normalized timing
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

function wallClock(instant: Date, timezone: string): WallClock & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** How far the zone's wall clock is ahead of UTC at this instant, in ms. */
function offsetAt(instant: number, timezone: string): number {
  const wall = wallClock(new Date(instant), timezone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in a zone. The offsets a day and a
 * half either side bracket any DST change near it (changes are months apart),
 * so one of the two candidates is it. A time a change repeats resolves to its
 * first occurrence; a time a change skips (02:30 on a spring-forward night)
 * resolves the same distance past the jump, 03:30. Either way a daily
 * schedule still runs exactly once that day.
 */
function zonedTimeToInstant(wall: WallClock, timezone: string): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const before = offsetAt(asUtc - 36 * HOUR_MS, timezone);
  const after = offsetAt(asUtc + 36 * HOUR_MS, timezone);
  const candidates = [...new Set([asUtc - before, asUtc - after])].sort((a, b) => a - b);
  for (const instant of candidates) {
    const seen = wallClock(new Date(instant), timezone);
    if (
      seen.year === wall.year &&
      seen.month === wall.month &&
      seen.day === wall.day &&
      seen.hour === wall.hour &&
      seen.minute === wall.minute
    ) {
      return new Date(instant);
    }
  }
  return new Date(asUtc - before);
}
