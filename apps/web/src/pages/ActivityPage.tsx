import { useCallback, useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableRowHeader } from "@/components/ui/table";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { listAudit, type AuditItem } from "../api/client.ts";

export function ActivityPage() {
  const { t } = useLocale();
  const [items, setItems] = useState<AuditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { const page = await listAudit(); setItems(page.items); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <LoadingState label={t.activity.loading} />;

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      {items.length === 0 ? <EmptyState icon={Clock} title={t.activity.emptyTitle} description={t.activity.emptyDescription} /> : (
        <Table><TableHeader><TableRow><TableHead>{t.activity.tableTime}</TableHead><TableHead>{t.activity.tableAction}</TableHead><TableHead>{t.activity.tableBucket}</TableHead><TableHead>{t.activity.tableStatus}</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => (
          <TableRow key={item.id}><TableRowHeader className="whitespace-nowrap">{new Date(item.createdAt).toLocaleString()}</TableRowHeader><TableCell>{item.action}</TableCell><TableCell>{item.bucketName ?? "-"}</TableCell><TableCell>{item.statusCode ?? "-"}</TableCell></TableRow>
        ))}</TableBody></Table>
      )}
    </div>
  );
}
