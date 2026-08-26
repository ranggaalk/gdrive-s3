import { useCallback, useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableRowHeader } from "@/components/ui/table";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { listAudit, type AuditItem } from "../api/client.ts";

export function ActivityPage() {
  const { t } = useLocale();
  const [items, setItems] = useState<AuditItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await listAudit();
      setItems(page.items);
      setNextBefore(page.nextBefore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listAudit(nextBefore);
      setItems((current) => [...current, ...page.items]);
      setNextBefore(page.nextBefore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) return <LoadingState label={t.activity.loading} />;

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      {items.length === 0 ? <EmptyState icon={Clock} title={t.activity.emptyTitle} description={t.activity.emptyDescription} /> : (
        <>
          <Table><TableHeader><TableRow><TableHead>{t.activity.tableTime}</TableHead><TableHead>{t.activity.tableAction}</TableHead><TableHead>{t.activity.tableBucket}</TableHead><TableHead>{t.activity.tableStatus}</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => (
            <TableRow key={item.id}><TableRowHeader className="whitespace-nowrap">{new Date(item.createdAt).toLocaleString()}</TableRowHeader><TableCell>{item.action}</TableCell><TableCell>{item.bucketName ?? "-"}</TableCell><TableCell>{item.statusCode ?? "-"}</TableCell></TableRow>
          ))}</TableBody></Table>
          {nextBefore ? (
            <div className="flex justify-center">
              <Button variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? t.common.loadingMore : t.common.loadMore}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
