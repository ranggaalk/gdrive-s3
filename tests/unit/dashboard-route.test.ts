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
    expect(parseDashboardLocation({ pathname: "/" })).toEqual({
      kind: "section",
      page: "overview",
    });
    expect(parseDashboardLocation({ pathname: "/unknown" })).toEqual({
      kind: "section",
      page: "overview",
    });
    expect(dashboardRouteUrl(parseDashboardLocation({ pathname: "/unknown" }))).toBe("/");
  });

  test("round trips every dashboard section", () => {
    for (const page of sections) {
      const route = { kind: "section" as const, page };
      const url = dashboardRouteUrl(route);
      expect(parseDashboardLocation({ pathname: url })).toEqual(route);
      expect(dashboardSection(route)).toBe(page);
    }
  });

  test("models bucket details as a nested buckets path", () => {
    const route = parseDashboardLocation({ pathname: "/buckets/bucket_123" });
    expect(route).toEqual({
      kind: "bucket",
      page: "buckets",
      bucketId: "bucket_123",
    });
    expect(dashboardSection(route)).toBe("buckets");
  });

  test("encodes bucket IDs safely and round trips them", () => {
    const url = dashboardRouteUrl({
      kind: "bucket",
      page: "buckets",
      bucketId: "bucket / finance",
    });
    expect(url).toBe("/buckets/bucket%20%2F%20finance");
    expect(parseDashboardLocation({ pathname: url })).toEqual({
      kind: "bucket",
      page: "buckets",
      bucketId: "bucket / finance",
    });
  });

  test("ignores blank bucket segments and extra nested segments", () => {
    expect(parseDashboardLocation({ pathname: "/buckets" })).toEqual({
      kind: "section",
      page: "buckets",
    });
    expect(parseDashboardLocation({ pathname: "/buckets/%20" })).toEqual({
      kind: "section",
      page: "buckets",
    });
    expect(parseDashboardLocation({ pathname: "/activity" })).toEqual({
      kind: "section",
      page: "activity",
    });
  });
});
