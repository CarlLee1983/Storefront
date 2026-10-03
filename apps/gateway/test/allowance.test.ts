import { beforeEach, describe, expect, it } from "vitest";
import { api, basic, bearer, resetDb, send } from "./helpers";

const issueInvoice = (invoiceKey: string, amountTwd = 1000) => api("POST", "/v1/invoices", { invoiceKey, merchantReference: "12", amountTwd });
const allow = (invoiceKey: string, allowanceKey: string, amountTwd: number) => api("POST", `/v1/invoices/${invoiceKey}/allowances`, { allowanceKey, amountTwd });
const lookup = (allowanceKey: string) => api("GET", `/v1/allowances/${allowanceKey}`);
const toggle = (name: "toggle-failure" | "toggle-lost-response", headers: Record<string, string> = basic()) =>
  send(`/console/allowances/${name}`, { method: "POST", headers, redirect: "manual" });

describe("模擬發票折讓 POST /v1/invoices/:invoiceKey/allowances", () => {
  beforeEach(async () => {
    await resetDb();
    await issueInvoice("inv_1", 1000);
  });

  it("折讓：回折讓號碼、金額與發票鍵，查證回同一張；同鍵重送冪等，同鍵不同金額回 409", async () => {
    const response = await allow("inv_1", "alw_1", 300);

    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { allowanceNumber: string } };
    expect(data).toMatchObject({ allowanceKey: "alw_1", invoiceKey: "inv_1", amountTwd: 300, allowanceNumber: expect.stringMatching(/^SA-[0-9A-F]{8}$/) });
    expect(await (await lookup("alw_1")).json()).toEqual({ ok: true, data });
    expect(await (await (await allow("inv_1", "alw_1", 300)).json())).toEqual({ ok: true, data });
    const conflict = await allow("inv_1", "alw_1", 200);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "allowance_conflict" } });
  });

  it("發票不存在回 404，不產生無原票的折讓；累計折讓超過原額回 422，剛好用完可以", async () => {
    const missing = await allow("inv_none", "alw_x", 100);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "invoice_not_found" } });
    expect((await lookup("alw_x")).status).toBe(404);

    expect((await allow("inv_1", "alw_1", 600)).status).toBe(200);
    const over = await allow("inv_1", "alw_2", 401);
    expect(over.status).toBe(422);
    expect(await over.json()).toMatchObject({ error: { code: "allowance_exceeds_invoice" } });
    expect((await lookup("alw_2")).status).toBe(404);
    expect((await allow("inv_1", "alw_2", 400)).status).toBe(200);
  });

  it("沒有 API 金鑰回 401；輸入不合法回 400；從未收到的 allowanceKey 查證回 404 allowance_not_found", async () => {
    expect((await api("POST", "/v1/invoices/inv_1/allowances", { allowanceKey: "a", amountTwd: 1 }, {})).status).toBe(401);
    expect((await allow("inv_1", "bad key!", 1)).status).toBe(400);
    expect((await allow("inv_1", "alw_1", 0)).status).toBe(400);
    const missing = await lookup("alw_none");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "allowance_not_found" } });
  });

  it("下一次折讓失敗：回 502 且不折讓，旗標用完即清，同一個 allowanceKey 重試成功", async () => {
    expect((await toggle("toggle-failure")).status).toBe(303);

    const failed = await allow("inv_1", "alw_1", 100);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { code: "allowance_failed" } });
    expect((await lookup("alw_1")).status).toBe(404);

    expect((await allow("inv_1", "alw_1", 100)).status).toBe(200);
  });

  it("下一次折讓回應遺失：回 504 但折讓已開立，查證找得到，重送不重複折讓", async () => {
    await toggle("toggle-lost-response");

    expect((await allow("inv_1", "alw_1", 100)).status).toBe(504);
    const found = (await (await lookup("alw_1")).json()) as { data: { allowanceNumber: string } };
    const again = (await (await allow("inv_1", "alw_1", 100)).json()) as { data: { allowanceNumber: string } };

    expect(again.data.allowanceNumber).toBe(found.data.allowanceNumber);
  });

  it("主控頁顯示旗標與最近的折讓；切換需要 Basic 認證", async () => {
    expect((await toggle("toggle-failure", bearer())).status).toBe(401);
    await allow("inv_1", "alw_9", 100);
    await toggle("toggle-failure");

    const html = await (await send("/console", { headers: basic() })).text();

    expect(html).toContain("下一次折讓失敗：是");
    expect(html).toContain("alw_9");
  });
});
