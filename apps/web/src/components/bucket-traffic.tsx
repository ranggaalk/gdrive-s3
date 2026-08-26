import { useEffect, useMemo, useState } from "react";
import Chart from "react-apexcharts";
import type { ApexOptions } from "apexcharts";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { humanBytes } from "@/lib/format";
import {
  getBucketTraffic,
  getOverviewTraffic,
  type BucketTraffic as BucketTrafficData,
  type TrafficRange,
} from "@/api/client";

const POLL_MS = 15_000;

const RANGES: Array<{ value: TrafficRange; label: string }> = [
  { value: "1h", label: "1 Jam" },
  { value: "24h", label: "24 Jam" },
  { value: "7d", label: "7 Hari" },
];

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
        <div className="grid grid-cols-3 gap-2">
          {RANGES.map((r) => (
            <Button key={r.value} type="button" size="sm" variant={range === r.value ? "default" : "outline"} onClick={() => setRange(r.value)}>
              {r.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">Diperbarui otomatis tiap {POLL_MS / 1000} detik.</p>
          {onViewDetail ? (
            <Button type="button" size="sm" variant="outline" onClick={onViewDetail}>
              Lihat detail
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <ErrorAlert message={error} /> : null}
      {loading && !data ? (
        <LoadingState label="Memuat traffic" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Bandwidth</CardTitle>
              <CardDescription>
                Total: <span className="font-medium text-foreground">{humanBytes(totals.bytesIn)} masuk</span> ·{" "}
                <span className="font-medium text-foreground">{humanBytes(totals.bytesOut)} keluar</span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Chart
                type="area"
                height={260}
                colors={[c.blue, c.orange]}
                series={[
                  { name: "Bytes masuk", data: xy(points.map((p) => p.bytesIn)) },
                  { name: "Bytes keluar", data: xy(points.map((p) => p.bytesOut)) },
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
              <CardTitle className="text-base">Request</CardTitle>
              <CardDescription>
                Total: <span className="font-medium text-foreground">{totals.requests} request</span>
                {totals.errors > 0 ? <span className="text-destructive"> · {totals.errors} error</span> : null}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Chart
                type="area"
                height={260}
                colors={[c.blue, c.critical]}
                series={[
                  { name: "Request", data: xy(points.map((p) => p.requests)) },
                  { name: "Error", data: xy(points.map((p) => p.errors)) },
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
