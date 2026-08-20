export type DashboardSection =
  | "overview"
  | "buckets"
  | "credentials"
  | "activity"
  | "documentation";

export type DashboardRoute =
  | { kind: "section"; page: DashboardSection }
  | { kind: "bucket"; page: "buckets"; bucketId: string };

const SECTIONS = new Set<DashboardSection>([
  "overview",
  "buckets",
  "credentials",
  "activity",
  "documentation",
]);

export function parseDashboardLocation(
  location: { search: string },
): DashboardRoute {
  const params = new URLSearchParams(location.search);
  const page = params.get("page");

  if (!page) return { kind: "section", page: "overview" };
  if (!SECTIONS.has(page as DashboardSection)) {
    return { kind: "section", page: "overview" };
  }

  if (page === "buckets") {
    const bucketId = params.get("bucket")?.trim();
    if (bucketId) return { kind: "bucket", page: "buckets", bucketId };
  }

  return { kind: "section", page: page as DashboardSection };
}

export function dashboardRouteUrl(route: DashboardRoute): string {
  if (route.kind === "section" && route.page === "overview") return "/";

  const params = new URLSearchParams({ page: route.page });
  if (route.kind === "bucket") params.set("bucket", route.bucketId);
  return `/?${params.toString()}`;
}

export function dashboardSection(route: DashboardRoute): DashboardSection {
  return route.page;
}
