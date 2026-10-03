import { csvHeader, csvRows, type ExportRow } from "./orders-csv";

type Batch = { ok: true; data: { rows: ExportRow[]; nextBeforeId: number | null } } | { ok: false; reason: string };

/**
 * 匯出 CSV：逐批向 App 取回（每批的筆數與游標由 App 決定），邊取邊送出，Worker 記憶體不隨訂單總數成長。
 * 第一批先取回再回應，未授權（403）與條件無效（400）才有正確的狀態碼；之後某批失敗就讓串流出錯，
 * 下載會中斷而不是留下一份看似完整、其實缺資料的檔案。
 */
export async function exportOrdersResponse(readBatch: (beforeId?: number) => Promise<Batch>, filename: string): Promise<Response> {
  const first = await readBatch();
  if (!first.ok) return Response.json({ ok: false, reason: first.reason }, { status: first.reason === "unauthorized" ? 403 : 400, headers: { "cache-control": "no-store" } });

  let batch = first.data;
  let header = true;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      controller.enqueue(encoder.encode((header ? csvHeader() : "") + csvRows(batch.rows)));
      header = false;
      if (batch.nextBeforeId === null) return controller.close();
      const next = await readBatch(batch.nextBeforeId);
      if (!next.ok) throw new Error(`匯出中斷：${next.reason}`);
      batch = next.data;
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
