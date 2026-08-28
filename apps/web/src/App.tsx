import { useCallback, useEffect, useState } from "react";
import { Activity, BookOpen, Gauge, HardDriveDownload, KeyRound, PackageOpen, RefreshCw, Settings } from "lucide-react";
import { getBucket, getMe, MfaRequiredError, type Me, type Bucket } from "./api/client.ts";
import { AppShell, type NavigationItem } from "@/components/app-shell";
import { ErrorAlert, LoadingState, Spinner } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocale } from "@/components/locale-provider";
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
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { BackupAccountsPage } from "./pages/BackupAccountsPage.tsx";
import { SecurityPage } from "./pages/SecurityPage.tsx";
import { MfaVerifyPage } from "./pages/MfaVerifyPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";

export function App() {
  const { t } = useLocale();
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [route, setRoute] = useState<DashboardRoute>(() =>
    parseDashboardLocation(window.location),
  );
  const [activeBucket, setActiveBucket] = useState<Bucket | null>(null);
  const [bucketLoading, setBucketLoading] = useState(false);
  const [bucketError, setBucketError] = useState<string | null>(null);
  const [bucketLoadAttempt, setBucketLoadAttempt] = useState(0);

  const TITLES: Record<DashboardSection, string> = {
    overview: t.nav.overview,
    buckets: t.nav.buckets,
    credentials: t.nav.credentials,
    activity: t.nav.activity,
    documentation: t.nav.documentation,
    backup: t.nav.backup,
    settings: t.nav.settings,
    security: t.nav.security,
  };

  const NAVIGATION: Array<NavigationItem<DashboardSection>> = [
    { id: "overview", name: t.nav.overview, icon: Gauge },
    { id: "buckets", name: t.nav.buckets, icon: PackageOpen },
    { id: "credentials", name: t.nav.credentials, icon: KeyRound },
    { id: "backup", name: t.nav.backup, icon: HardDriveDownload },
    { id: "activity", name: t.nav.activity, icon: Activity },
    { id: "documentation", name: t.nav.documentation, icon: BookOpen },
  ];

  const load = useCallback(async () => {
    setLoading(true);
    setBootstrapError(null);
    setMfaRequired(false);
    try {
      setMe(await getMe());
    } catch (error) {
      if (error instanceof MfaRequiredError) {
        setMe(null);
        setMfaRequired(true);
      } else {
        setBootstrapError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const navigate = useCallback((nextRoute: DashboardRoute) => {
    const url = dashboardRouteUrl(nextRoute);
    if (window.location.pathname !== url || window.location.search || window.location.hash) {
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
    if (window.location.pathname !== canonical || window.location.search || window.location.hash) {
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
    return <main className="flex min-h-screen items-center justify-center"><Spinner className="text-primary" label={t.login.loadingSession} /></main>;
  }

  if (bootstrapError) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-lg">
          <CardHeader><CardTitle>{t.login.dashboardUnavailableTitle}</CardTitle><CardDescription>{t.login.dashboardUnavailableDescription}</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <ErrorAlert message={bootstrapError} />
            <Button onClick={() => void load()}><RefreshCw /> {t.common.retry}</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (mfaRequired) return <MfaVerifyPage onVerified={() => void load()} />;

  if (!me) return <LoginPage />;

  const section = dashboardSection(route);
  const navigateSection = (page: DashboardSection) =>
    navigate({ kind: "section", page });
  const navigation = me.isAdmin
    ? [...NAVIGATION, { id: "settings" as const, name: t.nav.settings, icon: Settings }]
    : NAVIGATION;

  return (
    <AppShell
      email={me.email}
      title={route.kind === "bucket" ? t.nav.objects : TITLES[section]}
      navigation={navigation}
      active={section}
      onSelect={navigateSection}
      onOpenSecurity={() => navigateSection("security")}
    >
      {route.kind === "section" && route.page === "overview" ? (
        <OverviewPage onViewTrafficDetail={() => navigateSection("activity")} />
      ) : null}
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
      {route.kind === "section" && route.page === "backup" ? <BackupAccountsPage /> : null}
      {route.kind === "section" && route.page === "settings" ? <SettingsPage /> : null}
      {route.kind === "section" && route.page === "security" ? <SecurityPage /> : null}
      {route.kind === "bucket" &&
      (bucketLoading || (!bucketError && activeBucket?.id !== route.bucketId)) ? (
        <LoadingState label={t.login.loadingBucket} />
      ) : null}
      {route.kind === "bucket" && bucketError ? (
        <div className="space-y-4">
          <ErrorAlert title={t.login.bucketUnavailableTitle} message={bucketError} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setBucketLoadAttempt((attempt) => attempt + 1)}><RefreshCw /> {t.common.retry}</Button>
            <Button variant="outline" onClick={() => navigateSection("buckets")}>{t.login.backToBuckets}</Button>
          </div>
        </div>
      ) : null}
      {route.kind === "bucket" && activeBucket?.id === route.bucketId ? (
        <ObjectsPage
          bucket={activeBucket}
          onBack={() => navigateSection("buckets")}
          onOpenBackupAccounts={() => navigateSection("backup")}
        />
      ) : null}
    </AppShell>
  );
}
