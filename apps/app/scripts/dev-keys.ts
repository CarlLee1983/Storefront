// vitest.config.ts（測試）與 admin-dev-token.ts（本機開發）共用：產生 Access 測試用的 RS256 金鑰並簽 JWT。
import { LOCAL_TEAM_DOMAIN } from "../src/admin/access";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";


export interface DevKeys {
  privateKey: CryptoKey;
  publicJwk: JWK;
  privateJwk: JWK;
}

export async function generateDevKeys(kid: string): Promise<DevKeys> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const meta = { alg: "RS256", use: "sig", kid };
  return {
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), ...meta },
    privateJwk: { ...(await exportJWK(privateKey)), ...meta },
  };
}

export interface AccessJwtOptions {
  privateKey: CryptoKey;
  kid: string;
  email: string;
  audience: string;
  lifetimeSeconds: number;
}

/** 簽一張 Access 風格的 JWT（RS256，iss 為 `https://local.invalid`），給內嵌 JWKS 模式使用。 */
export async function signAccessJwt({ privateKey, kid, email, audience, lifetimeSeconds }: AccessJwtOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(`https://${LOCAL_TEAM_DOMAIN}`)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + lifetimeSeconds)
    .sign(privateKey);
}
