import type { ProductImageBucket } from "../src/images/upload";
import { env } from "cloudflare:workers";
import { generateKeyPair, importJWK, SignJWT } from "jose";
import { TEST_AUD, TEST_KID, TEST_TEAM_DOMAIN } from "./constants";

export const ADMIN_EMAIL = "admin@example.com";

interface TokenOptions {
  email?: string | null;
  aud?: string;
  iss?: string;
  /** exp / iat 為 UTC epoch 秒。 */
  iat?: number;
  exp?: number;
  /** 不給就用 env 裡的測試私鑰；給了就用這把（模擬簽章無效）。 */
  key?: CryptoKey;
  alg?: string;
}

/** 目前（被偽造的）時間之下有效的 Access JWT：不傳 iat/exp 時取 Date.now() 前後一小時。 */
export async function mintAccessJwt(options: TokenOptions = {}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const key = options.key ?? (await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK), "RS256"));
  const claims: Record<string, unknown> = {};
  if (options.email !== null) claims.email = options.email ?? ADMIN_EMAIL;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? "RS256", kid: TEST_KID })
    .setIssuer(options.iss ?? `https://${TEST_TEAM_DOMAIN}`)
    .setAudience(options.aud ?? TEST_AUD)
    .setIssuedAt(options.iat ?? nowSeconds - 60)
    .setExpirationTime(options.exp ?? nowSeconds + 3600)
    .sign(key);
}

/** 另一把不在 JWKS 裡的金鑰（同 kid），用來簽出「簽章無效」的 JWT。 */
export async function generateRogueKey(): Promise<CryptoKey> {
  const { privateKey } = await generateKeyPair("RS256");
  return privateKey;
}

/** `createAdminService` 的相依：補查付款、重試退款與補辦發票不是這些測試要驗的，被呼叫就丟錯（讓誤用立刻現形）。 */
export function adminDeps(images?: ProductImageBucket) {
  return {
    images,
    reconcilePayment: (): never => {
      throw new Error("這個測試不該補查付款");
    },
    retryRefund: (): never => {
      throw new Error("這個測試不該重試退款");
    },
    retryInvoice: (): never => {
      throw new Error("這個測試不該補辦發票");
    },
  };
}
