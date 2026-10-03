import { beforeEach, describe, expect, it } from "vitest";
import { api, basic, bearer, resetDb, send } from "./helpers";

const issue = (invoiceKey: string, amountTwd = 1000, merchantReference = "12") => api("POST", "/v1/invoices", { invoiceKey, merchantReference, amountTwd });
const lookup = (invoiceKey: string) => api("GET", `/v1/invoices/${invoiceKey}`);
const toggle = (name: "toggle-failure" | "toggle-lost-response", headers: Record<string, string> = basic()) =>
  send(`/console/invoices/${name}`, { method: "POST", headers, redirect: "manual" });

describe("模擬發票 POST /v1/invoices", () => {
  beforeEach(resetDb);

  it("開立發票：回發票號碼、原額與開立時間，查證回同一張", async () => {
    const response = await issue("inv_1", 1000);

    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { invoiceKey: string; invoiceNumber: string; amountTwd: number; issuedAt: number } };
    expect(data).toMatchObject({ invoiceKey: "inv_1", amountTwd: 1000, merchantReference: "12", invoiceNumber: expect.stringMatching(/^SM-[0-9A-F]{8}$/) });
    expect(await (await lookup("inv_1")).json()).toEqual({ ok: true, data });
  });

  it("同一個 invoiceKey 重送冪等：回同一張發票（同號碼），同鍵不同金額回 409", async () => {
    const first = (await (await issue("inv_1", 1000)).json()) as { data: { invoiceNumber: string } };

    const again = await issue("inv_1", 1000);
    const conflict = await issue("inv_1", 999);

    expect(((await again.json()) as typeof first).data.invoiceNumber).toBe(first.data.invoiceNumber);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ ok: false, error: { code: "invoice_conflict" } });
  });

  it("沒有 API 金鑰回 401；輸入不合法回 400；從未收到的 invoiceKey 查證回 404 invoice_not_found", async () => {
    expect((await api("POST", "/v1/invoices", { invoiceKey: "inv_1", merchantReference: "1", amountTwd: 1 }, {})).status).toBe(401);
    expect((await issue("bad key!", 1)).status).toBe(400);
    expect((await issue("inv_1", 0)).status).toBe(400);
    const missing = await lookup("inv_none");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "invoice_not_found" } });
  });

  it("下一次開立失敗：回 502 invoice_failed 且不開立，旗標用完即清，同一個 invoiceKey 重試成功", async () => {
    expect((await toggle("toggle-failure")).status).toBe(303);

    const failed = await issue("inv_1");
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { code: "invoice_failed" } });
    expect((await lookup("inv_1")).status).toBe(404);

    expect((await issue("inv_1")).status).toBe(200);
  });

  it("下一次開立回應遺失：回 504 invoice_timeout 但發票已開立，查證找得到，重送不重複開立", async () => {
    await toggle("toggle-lost-response");

    const lost = await issue("inv_1");
    expect(lost.status).toBe(504);
    const found = (await (await lookup("inv_1")).json()) as { data: { invoiceNumber: string } };
    const again = (await (await issue("inv_1")).json()) as { data: { invoiceNumber: string } };

    expect(again.data.invoiceNumber).toBe(found.data.invoiceNumber);
  });

  it("主控頁顯示旗標與最近開立的發票；切換需要 Basic 認證", async () => {
    expect((await toggle("toggle-failure", bearer())).status).toBe(401);
    await issue("inv_9", 640, "order-<b>");
    await toggle("toggle-failure");

    const html = await (await send("/console", { headers: basic() })).text();

    expect(html).toContain("下一次開立發票失敗：是");
    expect(html).toContain("inv_9");
    expect(html).toContain("order-&lt;b&gt;");
  });
});
