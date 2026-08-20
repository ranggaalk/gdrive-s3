import { useCallback, useEffect, useState } from "react";
import { Activity, BookOpen, Gauge, HardDrive, KeyRound, LogIn, PackageOpen, RefreshCw } from "lucide-react";
import { getBucket, getMe, type Me, type Bucket } from "./api/client.ts";
import { AppShell, type NavigationItem } from "@/components/app-shell";
import { ErrorAlert, LoadingState, Spinner } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  dashboardRouteUrl,
  dashboardSection,
  parseDashboardLocation,
  type DashboardRoute,
  type DashboardSection,
} from "@/lib/dashboard-route";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { BucketsPage } from "./pages/BucketsPage.tsx";
import { CredentialsPage } from "./pages/CredentialsPage.tsx";
import { ObjectsPage } from "./pages/ObjectsPage.tsx";
import { ActivityPage } from "./pages/ActivityPage.tsx";
import { DocsPage } from "./pages/DocsPage.tsx";

const TITLES: Record<DashboardSection, string> = {
  overview: "Overview",
  buckets: "Buckets",
  credentials: "S3 Credentials",
  activity: "Activity",
  documentation: "Dokumentasi",
};

const NAVIGATION: Array<NavigationItem<DashboardSection>> = [
  { id: "overview", name: "Overview", icon: Gauge },
  { id: "buckets", name: "Buckets", icon: PackageOpen },
  { id: "credentials", name: "S3 Credentials", icon: KeyRound },
  { id: "activity", name: "Activity", icon: Activity },
  { id: "documentation", name: "Dokumentasi", icon: BookOpen },
];

function LoginPage() {
  const params = new URLSearchParams(window.location.search);
  const loginError = params.get("login_error");

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-primary/10 via-background to-background p-4">
      <Card className="w-full max-w-lg shadow-xl">
        <CardHeader className="items-center text-center">
          <div className="mb-3 rounded-2xl bg-primary p-3 text-primary-foreground shadow-lg shadow-primary/20">
            <HardDrive className="size-8" aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl">DriveS3 Gateway</CardTitle>
          <CardDescription className="max-w-md text-base">
            Bucket dapat disimpan di <strong className="text-foreground">My Drive</strong> pribadi atau Google <strong className="text-foreground">Shared Drive</strong> organisasi.
            Masuk hanya diizinkan untuk domain Google Workspace organisasi Anda.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loginError ? <ErrorAlert title="Login gagal" message="Google tidak dapat menyelesaikan proses masuk. Silakan coba lagi." /> : null}
          <Button asChild size="lg" className="w-full">
            <a href="/auth/google/start"><LogIn /> Masuk dengan Google</a>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

export function App() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [route, setRoute] = useState<DashboardRoute>(() =>
    parseDashboardLocation(window.location),
  );
  const [activeBucket, setActiveBucket] = useState<Bucket | null>(null);
  const [bucketLoading, setBucketLoading] = useState(false);
  const [bucketError, setBucketError] = useState<string | null>(null);
  const [bucketLoadAttempt, setBucketLoadAttempt] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setBootstrapError(null);
    try {
      setMe(await getMe());
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const navigate = useCallback((nextRoute: DashboardRoute) => {
    const url = dashboardRouteUrl(nextRoute);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== url || window.location.hash) {
      window.history.pushState(null, "", url);
    }
    setRoute(nextRoute);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onPopState = () => setRoute(parseDashboardLocation(window.location));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!me) return;
    const canonical = dashboardRouteUrl(route);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== canonical || window.location.hash) {
      window.history.replaceState(null, "", canonical);
    }
  }, [me, route]);

  useEffect(() => {
    if (!me || route.kind !== "bucket") {
      setActiveBucket(null);
      setBucketLoading(false);
      setBucketError(null);
      return;
    }

    let cancelled = false;
    setActiveBucket(null);
    setBucketLoading(true);
    setBucketError(null);
    void getBucket(route.bucketId)
      .then((bucket) => {
        if (!cancelled) setActiveBucket(bucket);
      })
      .catch((error) => {
        if (!cancelled) {
          setBucketError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setBucketLoading(false);
      });
    return () => { cancelled = true; };
  }, [me, route, bucketLoadAttempt]);

  if (loading) {
    return <main className="flex min-h-screen items-center justify-center"><Spinner className="text-primary" label="Memuat sesi" /></main>;
  }

  if (bootstrapError) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-lg">
          <CardHeader><CardTitle>Dashboard tidak dapat dimuat</CardTitle><CardDescription>Koneksi ke control plane gagal.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <ErrorAlert message={bootstrapError} />
            <Button onClick={() => void load()}><RefreshCw /> Coba lagi</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!me) return <LoginPage />;

  const section = dashboardSection(route);
  const navigateSection = (page: DashboardSection) =>
    navigate({ kind: "section", page });

  return (
    <AppShell
      email={me.email}
      title={route.kind === "bucket" ? "Objects" : TITLES[section]}
      navigation={NAVIGATION}
      active={section}
      onSelect={navigateSection}
    >
      {route.kind === "section" && route.page === "overview" ? <OverviewPage /> : null}
      {route.kind === "section" && route.page === "buckets" ? (
        <BucketsPage onOpen={(bucket) => navigate({ kind: "bucket", page: "buckets", bucketId: bucket.id })} />
      ) : null}
      {route.kind === "section" && route.page === "credentials" ? <CredentialsPage /> : null}
      {route.kind === "section" && route.page === "activity" ? <ActivityPage /> : null}
      {route.kind === "section" && route.page === "documentation" ? (
        <DocsPage
          onOpenBuckets={() => navigateSection("buckets")}
          onOpenCredentials={() => navigateSection("credentials")}
        />
      ) : null}
      {route.kind === "bucket" &&
      (bucketLoading || (!bucketError && activeBucket?.id !== route.bucketId)) ? (
        <LoadingState label="Memuat bucket" />
      ) : null}
      {route.kind === "bucket" && bucketError ? (
        <div className="space-y-4">
          <ErrorAlert title="Bucket tidak dapat dimuat" message={bucketError} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setBucketLoadAttempt((attempt) => attempt + 1)}><RefreshCw /> Coba lagi</Button>
            <Button variant="outline" onClick={() => navigateSection("buckets")}>Kembali ke buckets</Button>
          </div>
        </div>
      ) : null}
      {route.kind === "bucket" && activeBucket?.id === route.bucketId ? (
        <ObjectsPage bucket={activeBucket} onBack={() => navigateSection("buckets")} />
      ) : null}
    </AppShell>
  );
}
