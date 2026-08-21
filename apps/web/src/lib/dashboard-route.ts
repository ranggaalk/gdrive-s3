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

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseDashboardLocation(
  location: { pathname: string },
): DashboardRoute {
  const segments = location.pathname.split("/").filter(Boolean);
  const first = segments[0];

  if (!first || !SECTIONS.has(first as DashboardSection)) {
    return { kind: "section", page: "overview" };
  }

  if (first === "buckets" && segments[1] !== undefined) {
    const bucketId = safeDecode(segments[1]).trim();
    if (bucketId) return { kind: "bucket", page: "buckets", bucketId };
  }

  return { kind: "section", page: first as DashboardSection };
}

export function dashboardRouteUrl(route: DashboardRoute): string {
  if (route.kind === "bucket") {
    return `/buckets/${encodeURIComponent(route.bucketId)}`;
  }
  if (route.page === "overview") return "/";
  return `/${route.page}`;
}

export function dashboardSection(route: DashboardRoute): DashboardSection {
  return route.page;
}
