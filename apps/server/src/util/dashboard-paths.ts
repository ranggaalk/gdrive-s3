// Top-level paths the dashboard owns. DashboardServer answers them with the
// app's index.html, since a refresh -- or a redirect from sign-in -- lands on
// one, and isValidBucketName refuses them as bucket names, so no path-style S3
// request can ever mean one of them.
export const DASHBOARD_ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  // Sections, as apps/web/src/lib/dashboard-route.ts routes them.
  "overview",
  "buckets",
  "credentials",
  "activity",
  "documentation",
  "backup",
  "quota",
  "settings",
  "security",
  // Where sign-in sends a session that still owes its second factor
  // (routes/auth.ts); the app shows the code prompt on any path.
  "mfa",
]);
