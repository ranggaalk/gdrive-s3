import { describe, expect, test } from "bun:test";
import {
  dashboardRouteUrl,
  dashboardSection,
  parseDashboardLocation,
  type DashboardSection,
} from "../../apps/web/src/lib/dashboard-route.ts";

const sections: DashboardSection[] = [
  "overview",
  "buckets",
  "credentials",
  "activity",
  "documentation",
];

describe("dashboard route", () => {
  test("defaults empty and unknown locations to overview", () => {
    expect(parseDashboardLocation({ search: "" })).toEqual({
      kind: "section",
      page: "overview",
    });
    expect(parseDashboardLocation({ search: "?page=unknown&bucket=ignored" })).toEqual({
      kind: "section",
      page: "overview",
    });
    expect(dashboardRouteUrl(parseDashboardLocation({ search: "?page=unknown" }))).toBe("/");
  });

  test("round trips every dashboard section", () => {
    for (const page of sections) {
      const route = { kind: "section" as const, page };
      const url = new URL(dashboardRouteUrl(route), "http://dashboard.test");
      expect(parseDashboardLocation(url)).toEqual(route);
      expect(dashboardSection(route)).toBe(page);
    }
  });

  test("models bucket details as part of the buckets section", () => {
    const route = parseDashboardLocation({ search: "?page=buckets&bucket=bucket_123" });
    expect(route).toEqual({
      kind: "bucket",
      page: "buckets",
      bucketId: "bucket_123",
    });
    expect(dashboardSection(route)).toBe("buckets");
  });

  test("encodes bucket IDs safely and canonicalizes unrelated parameters", () => {
    const url = dashboardRouteUrl({
      kind: "bucket",
      page: "buckets",
      bucketId: "bucket / finance",
    });
    expect(url).toBe("/?page=buckets&bucket=bucket+%2F+finance");
    expect(parseDashboardLocation(new URL(url, "http://dashboard.test"))).toEqual({
      kind: "bucket",
      page: "buckets",
      bucketId: "bucket / finance",
    });
    expect(
      dashboardRouteUrl(
        parseDashboardLocation({ search: "?extra=1&page=buckets&bucket=bucket_123&bucket=duplicate" }),
      ),
    ).toBe("/?page=buckets&bucket=bucket_123");
  });

  test("ignores blank or misplaced bucket parameters", () => {
    expect(parseDashboardLocation({ search: "?page=buckets&bucket=%20" })).toEqual({
      kind: "section",
      page: "buckets",
    });
    expect(parseDashboardLocation({ search: "?page=activity&bucket=bucket_123" })).toEqual({
      kind: "section",
      page: "activity",
    });
  });
});
