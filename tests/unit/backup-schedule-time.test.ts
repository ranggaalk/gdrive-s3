import { describe, expect, test } from "bun:test";
import {
  nextRunAt,
  normalizeTiming,
  ScheduleInputError,
  type ScheduleTiming,
} from "../../apps/server/src/backup/schedule-time.ts";

const daily = (timeOfDay: string, timezone: string): ScheduleTiming => ({
  frequency: "daily", intervalMinutes: null, timeOfDay, daysOfWeek: null, timezone,
});
const at = (iso: string) => new Date(iso);
const next = (timing: ScheduleTiming, after: string) => nextRunAt(timing, at(after)).toISOString();

describe("nextRunAt", () => {
  test("an interval counts from the moment given", () => {
    const timing: ScheduleTiming = { frequency: "interval", intervalMinutes: 90, timeOfDay: null, daysOfWeek: null, timezone: "UTC" };
    expect(next(timing, "2026-10-09T10:00:00.000Z")).toBe("2026-10-09T11:30:00.000Z");
  });

  test("a daily time is read on the schedule's own wall clock", () => {
    // 02:00 WIB is 19:00 UTC the day before.
    expect(next(daily("02:00", "Asia/Jakarta"), "2026-10-09T10:00:00.000Z")).toBe("2026-10-09T19:00:00.000Z");
    expect(next(daily("02:00", "Asia/Jakarta"), "2026-10-09T19:00:00.000Z")).toBe("2026-10-10T19:00:00.000Z");
    expect(next(daily("00:00", "UTC"), "2026-12-31T23:59:00.000Z")).toBe("2027-01-01T00:00:00.000Z");
  });

  test("weekly picks the next listed weekday, wrapping past Sunday", () => {
    const timing: ScheduleTiming = {
      frequency: "weekly", intervalMinutes: null, timeOfDay: "09:00", daysOfWeek: [1, 5], timezone: "UTC",
    };
    // Friday 2026-10-09, after 09:00 -> Monday the 12th.
    expect(next(timing, "2026-10-09T10:00:00.000Z")).toBe("2026-10-12T09:00:00.000Z");
    // Friday, before 09:00 -> that same Friday.
    expect(next(timing, "2026-10-09T08:00:00.000Z")).toBe("2026-10-09T09:00:00.000Z");
    // Only Monday, already past this Monday's slot -> next Monday.
    expect(next({ ...timing, daysOfWeek: [1] }, "2026-10-12T09:00:00.000Z")).toBe("2026-10-19T09:00:00.000Z");
  });

  test("a time a DST change skips runs just after the jump, once", () => {
    // New York springs forward at 02:00 on 2026-03-08; 02:30 does not exist.
    const timing = daily("02:30", "America/New_York");
    expect(next(timing, "2026-03-07T12:00:00.000Z")).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
    expect(next(timing, "2026-03-08T07:30:00.000Z")).toBe("2026-03-09T06:30:00.000Z"); // 02:30 EDT
  });

  test("a time a DST change repeats runs at its first occurrence, once", () => {
    // New York falls back at 02:00 on 2026-11-01; 01:30 happens twice.
    const timing = daily("01:30", "America/New_York");
    expect(next(timing, "2026-10-31T12:00:00.000Z")).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT
    expect(next(timing, "2026-11-01T05:30:00.000Z")).toBe("2026-11-02T06:30:00.000Z"); // not 01:30 EST that day
  });

  test("works in zones far from UTC", () => {
    expect(next(daily("09:00", "Pacific/Kiritimati"), "2026-10-09T10:00:00.000Z")).toBe("2026-10-09T19:00:00.000Z");
    expect(next(daily("09:00", "Pacific/Pago_Pago"), "2026-10-09T10:00:00.000Z")).toBe("2026-10-09T20:00:00.000Z");
  });
});

describe("normalizeTiming", () => {
  test("keeps only the fields the frequency uses, and sorts weekdays", () => {
    expect(
      normalizeTiming(
        { frequency: "weekly", intervalMinutes: 60, timeOfDay: "07:15", daysOfWeek: [5, 1, 5], timezone: "Asia/Makassar" },
        15,
      ),
    ).toEqual({ frequency: "weekly", intervalMinutes: null, timeOfDay: "07:15", daysOfWeek: [1, 5], timezone: "Asia/Makassar" });
    expect(
      normalizeTiming({ frequency: "interval", intervalMinutes: 30, timeOfDay: "07:15", daysOfWeek: [1], timezone: "UTC" }, 15),
    ).toEqual({ frequency: "interval", intervalMinutes: 30, timeOfDay: null, daysOfWeek: null, timezone: "UTC" });
  });

  test.each([
    [{ frequency: "interval", intervalMinutes: 5 }, "intervalMinutes"],
    [{ frequency: "interval", intervalMinutes: 20000 }, "intervalMinutes"],
    [{ frequency: "daily", timeOfDay: "24:00" }, "timeOfDay"],
    [{ frequency: "daily", timeOfDay: "2:00" }, "timeOfDay"],
    [{ frequency: "weekly", timeOfDay: "02:00", daysOfWeek: [] }, "daysOfWeek"],
    [{ frequency: "weekly", timeOfDay: "02:00", daysOfWeek: [0] }, "daysOfWeek"],
    [{ frequency: "daily", timeOfDay: "02:00", timezone: "Mars/Olympus_Mons" }, "time zone"],
    [{ frequency: "hourly" }, "frequency"],
  ])("refuses %j", (override, message) => {
    const input = { intervalMinutes: null, timeOfDay: null, daysOfWeek: null, timezone: "UTC", ...override };
    expect(() => normalizeTiming(input as ScheduleTiming, 15)).toThrow(ScheduleInputError);
    expect(() => normalizeTiming(input as ScheduleTiming, 15)).toThrow(message);
  });
});
