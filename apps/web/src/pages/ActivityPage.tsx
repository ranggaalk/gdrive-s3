import { useCallback, useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Button, Table } from "@heroui/react";
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
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label={t.nav.activity}>
                <Table.Header>
                  <Table.Column isRowHeader>{t.activity.tableTime}</Table.Column>
                  <Table.Column>{t.activity.tableAction}</Table.Column>
                  <Table.Column>{t.activity.tableBucket}</Table.Column>
                  <Table.Column>{t.activity.tableStatus}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {items.map((item) => (
                    <Table.Row key={item.id} id={item.id}>
                      <Table.Cell className="whitespace-nowrap">{new Date(item.createdAt).toLocaleString()}</Table.Cell>
                      <Table.Cell>{item.action}</Table.Cell>
                      <Table.Cell>{item.bucketName ?? "-"}</Table.Cell>
                      <Table.Cell>{item.statusCode ?? "-"}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
          {nextBefore ? (
            <div className="flex justify-center">
              <Button variant="outline" isDisabled={loadingMore} onPress={() => void loadMore()}>
                {loadingMore ? t.common.loadingMore : t.common.loadMore}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
