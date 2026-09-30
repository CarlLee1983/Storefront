import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "../src/webhook-signature";

const SECRET = "whsec-test";
const BODY = JSON.stringify({ eventId: "evt_1", type: "payment.succeeded" });
const NOW = 1_800_000_000_000;

describe("webhook 簽章", () => {
  it("用同一把金鑰簽出的 header 驗證通過", async () => {
    const header = await signWebhook({ secret: SECRET, body: BODY, nowMs: NOW });

    expect(await verifyWebhookSignature({ secret: SECRET, header, body: BODY, nowMs: NOW })).toEqual({ ok: true });
  });

  it("header 格式是 t=<unix 秒>,v1=<64 位十六進位>", async () => {
    const header = await signWebhook({ secret: SECRET, body: BODY, nowMs: NOW });

    expect(header).toMatch(new RegExp(`^t=${NOW / 1000},v1=[0-9a-f]{64}$`));
  });

  it("body 被竄改時驗證失敗", async () => {
    const header = await signWebhook({ secret: SECRET, body: BODY, nowMs: NOW });

    expect(
      await verifyWebhookSignature({ secret: SECRET, header, body: BODY.replace("evt_1", "evt_2"), nowMs: NOW }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("金鑰錯誤時驗證失敗", async () => {
    const header = await signWebhook({ secret: SECRET, body: BODY, nowMs: NOW });

    expect(await verifyWebhookSignature({ secret: "other", header, body: BODY, nowMs: NOW })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("竄改 header 裡的 timestamp 會讓簽章對不上", async () => {
    const header = await signWebhook({ secret: SECRET, body: BODY, nowMs: NOW });
    const forged = header.replace(`t=${NOW / 1000}`, `t=${NOW / 1000 + 1}`);

    expect(await verifyWebhookSignature({ secret: SECRET, header: forged, body: BODY, nowMs: NOW })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("timestamp 與現在差距在容忍度內通過，超過（過去或未來）則拒絕", async () => {
    const header = await signWebhook({ secret: SECRET, body: BODY, nowMs: NOW });
    const verifyAt = (nowMs: number, toleranceSeconds?: number) =>
      verifyWebhookSignature({ secret: SECRET, header, body: BODY, nowMs, toleranceSeconds });

    expect(await verifyAt(NOW + 300_000)).toEqual({ ok: true });
    expect(await verifyAt(NOW + 301_000)).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
    expect(await verifyAt(NOW - 301_000)).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
    expect(await verifyAt(NOW + 60_000, 30)).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it.each(["", "garbage", "t=abc,v1=00", `t=${NOW / 1000}`, `t=${NOW / 1000},v1=zz`])(
    "格式不合的 header %j 回 malformed",
    async (header) => {
      expect(await verifyWebhookSignature({ secret: SECRET, header, body: BODY, nowMs: NOW })).toEqual({
        ok: false,
        reason: "malformed_header",
      });
    },
  );
});
