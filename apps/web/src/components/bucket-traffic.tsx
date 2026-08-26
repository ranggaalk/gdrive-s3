import { useEffect, useMemo, useState } from "react";
import Chart from "react-apexcharts";
import type { ApexOptions } from "apexcharts";
import { useTheme } from "@/components/theme-provider";
import { useLocale } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { humanBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  getBucketTraffic,
  getOverviewTraffic,
  type BucketTraffic as BucketTrafficData,
  type TrafficRange,
} from "@/api/client";

const POLL_MS = 15_000;

// Colors follow the dataviz skill's validated default palette (categorical
// slots 1/2 for identity series, status "critical" for the error count) —
// not the dashboard's own --primary token, which is near-white in dark mode
// and unusable as a chart series color.
const PALETTE = {
  light: { grid: "#e1e0d9", axis: "#898781", blue: "#2a78d6", orange: "#eb6834", critical: "#d03b3b" },
  dark: { grid: "#2c2c2a", axis: "#898781", blue: "#3987e5", orange: "#d95926", critical: "#e66767" },
};

const TOOLTIP_FORMAT: Record<BucketTrafficData["granularity"], string> = {
  minute: "HH:mm",
  hour: "dd MMM HH:mm",
  day: "dd MMM",
};

function baseOptions(mode: "light" | "dark", granularity: BucketTrafficData["granularity"] | undefined): ApexOptions {
  const c = PALETTE[mode];
  return {
    chart: { toolbar: { show: false }, background: "transparent", fontFamily: "inherit", animations: { enabled: false } },
    theme: { mode },
    grid: { borderColor: c.grid, strokeDashArray: 3 },
    xaxis: {
      type: "datetime",
      labels: { style: { colors: c.axis, fontSize: "11px" } },
      axisBorder: { color: c.grid },
      axisTicks: { color: c.grid },
    },
    stroke: { curve: "smooth", width: 2 },
    fill: { type: "gradient", gradient: { opacityFrom: 0.35, opacityTo: 0.05 } },
    dataLabels: { enabled: false },
    markers: { size: 0, hover: { size: 5 } },
    legend: { show: true, position: "top", horizontalAlign: "left", labels: { colors: c.axis } },
    tooltip: { shared: true, x: { format: granularity ? TOOLTIP_FORMAT[granularity] : "HH:mm" } },
  };
}

interface TrafficChartsProps {
  /** A bucket id scopes the chart to one bucket; omit for the dashboard-wide overview. */
  bucketId?: string;
  onViewDetail?: () => void;
}

function TrafficCharts({ bucketId, onViewDetail }: TrafficChartsProps) {
  const { resolvedTheme } = useTheme();
  const { t } = useLocale();
  const RANGES: Array<{ value: TrafficRange; label: string }> = [
    { value: "1h", label: t.traffic.range1h },
    { value: "24h", label: t.traffic.range24h },
    { value: "7d", label: t.traffic.range7d },
  ];
  const [range, setRange] = useState<TrafficRange>("1h");
  const [data, setData] = useState<BucketTrafficData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async () => {
      try {
        const result = bucketId ? await getBucketTraffic(bucketId, range) : await getOverviewTraffic(range);
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const interval = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [bucketId, range]);

  const points = data?.points ?? [];
  const totals = useMemo(
    () =>
      points.reduce(
        (acc, p) => ({
          requests: acc.requests + p.requests,
          errors: acc.errors + p.errors,
          bytesIn: acc.bytesIn + p.bytesIn,
          bytesOut: acc.bytesOut + p.bytesOut,
        }),
        { requests: 0, errors: 0, bytesIn: 0, bytesOut: 0 },
      ),
    [points],
  );

  const opts = baseOptions(resolvedTheme, data?.granularity);
  const c = PALETTE[resolvedTheme];
  const xy = (values: number[]) => points.map((p, i) => ({ x: new Date(p.t).getTime(), y: values[i] }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1 rounded-full bg-muted p-1">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => setRange(r.value)}
              aria-pressed={range === r.value}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                range === r.value
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">{t.traffic.autoRefresh(POLL_MS / 1000)}</p>
          {onViewDetail ? (
            <Button type="button" size="sm" variant="outline" onClick={onViewDetail}>
              {t.traffic.viewDetail}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <ErrorAlert message={error} /> : null}
      {loading && !data ? (
        <LoadingState label={t.traffic.loading} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.traffic.bandwidthTitle}</CardTitle>
              <CardDescription>{t.traffic.bandwidthTotal(humanBytes(totals.bytesIn), humanBytes(totals.bytesOut))}</CardDescription>
            </CardHeader>
            <CardContent>
              <Chart
                type="area"
                height={260}
                colors={[c.blue, c.orange]}
                series={[
                  { name: t.traffic.bytesInSeries, data: xy(points.map((p) => p.bytesIn)) },
                  { name: t.traffic.bytesOutSeries, data: xy(points.map((p) => p.bytesOut)) },
                ]}
                options={{
                  ...opts,
                  yaxis: { labels: { style: { colors: c.axis, fontSize: "11px" }, formatter: (v: number) => humanBytes(Math.round(v)) } },
                  tooltip: { ...opts.tooltip, y: { formatter: (v: number) => humanBytes(Math.round(v)) } },
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.traffic.requestTitle}</CardTitle>
              <CardDescription>
                {t.traffic.requestTotal(totals.requests)}
                {totals.errors > 0 ? <span className="text-destructive">{t.traffic.errorSuffix(totals.errors)}</span> : null}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Chart
                type="area"
                height={260}
                colors={[c.blue, c.critical]}
                series={[
                  { name: t.traffic.requestSeries, data: xy(points.map((p) => p.requests)) },
                  { name: t.traffic.errorSeries, data: xy(points.map((p) => p.errors)) },
                ]}
                options={{
                  ...opts,
                  yaxis: { labels: { style: { colors: c.axis, fontSize: "11px" } }, forceNiceScale: true },
                  tooltip: { ...opts.tooltip, y: { formatter: (v: number) => String(Math.round(v)) } },
                }}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export function BucketTraffic({ bucketId }: { bucketId: string }) {
  return <TrafficCharts bucketId={bucketId} />;
}

export function OverviewTraffic({ onViewDetail }: { onViewDetail?: () => void }) {
  return <TrafficCharts onViewDetail={onViewDetail} />;
}
