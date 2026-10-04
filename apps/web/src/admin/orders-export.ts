import { csvCell, csvHeader, csvRows, type ExportRow } from "./orders-csv";

/** 結尾列的開頭；`#` 不是公式字元，不會被 `csvCell` 補單引號。 */
const EXPORT_TRAILER_PREFIX = "# ";

/** 台北日期（`YYYYMMDD`），給匯出檔名。 */
export const taipeiDateStamp = (now: number): string => new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll("-", "");

type Batch = { ok: true; data: { rows: ExportRow[]; nextBeforeId: number | null } } | { ok: false; reason: string };

/**
 * 匯出 CSV：逐批向 App 取回（每批的筆數與游標由 App 決定），邊取邊送出，Worker 記憶體不隨訂單總數成長。
 * 全部送完後補一列結尾（`# 共 N 筆，匯出完成`）。第一批先取回再回應，未授權（403）與條件無效（400）才有正確的狀態碼；之後某批失敗就讓串流出錯，
 * 下載會中斷而不是留下一份看似完整、其實缺資料的檔案。
 */
export async function exportOrdersResponse(readBatch: (beforeId?: number) => Promise<Batch>, filename: string): Promise<Response> {
  const first = await readBatch();
  if (!first.ok) return Response.json({ ok: false, reason: first.reason }, { status: first.reason === "unauthorized" ? 403 : 400, headers: { "cache-control": "no-store" } });

  let batch = first.data;
  let header = true;
  let total = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      total += batch.rows.length;
      controller.enqueue(encoder.encode((header ? csvHeader() : "") + csvRows(batch.rows)));
      header = false;
      if (batch.nextBeforeId === null) {
        // 結尾列：下載被中斷時檔案沒有這一列，據此確認檔案完整
        controller.enqueue(encoder.encode(`${csvCell(`${EXPORT_TRAILER_PREFIX}共 ${total} 筆，匯出完成`)}\r\n`));
        return controller.close();
      }
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
