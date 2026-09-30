import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import type { Clock } from "../shared/clock";
import { fail, ok, type Result } from "../shared/result";

/** Holdfast ADR 0007（https://github.com/CarlLee1983/Holdfast/blob/main/docs/adr/0007-admin-behind-cloudflare-access.md）：應用程式只驗 Access 簽發的 JWT，操作者以其中的 email 為準。 */
export interface AccessConfig {
  /** `<team>.cloudflareaccess.com`（可帶 `https://`、大小寫不拘）或本機專用的 `local.invalid`；空字串 = 尚未設定。 */
  teamDomain?: string;
  /** Access application 的 Audience (AUD) Tag；空字串 = 尚未設定。 */
  audience?: string;
  /** 內嵌 JWKS，僅在 teamDomain 為 `local.invalid` 時採用；搭配真實網域視為設定錯誤。 */
  jwksJson?: string;
}

export interface AccessIdentity {
  email: string;
}

export type AccessVerifyResult = Result<AccessIdentity, "unauthorized">;

/** JWKS 快取存活時間；金鑰輪替時最久這麼久之後會重新抓取（jose 也會在遇到未知 kid 時重抓，冷卻 30 秒）。 */
const JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;
/** 容許的時鐘誤差（秒），套用在 exp / nbf。 */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * 內嵌 JWKS 模式專用的保留網域：只有它才會採用 ACCESS_JWKS_JSON（.invalid 不會解析到真實主機）。
 * scripts/dev-keys.ts 與測試共用這個常數。
 */
export const LOCAL_TEAM_DOMAIN = "local.invalid";
/** 遠端 JWKS 模式只接受 Cloudflare Access 的團隊網域，避免設定被改成任意主機後去信任它的金鑰。 */
const ACCESS_TEAM_DOMAIN_PATTERN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;

// 模組層級快取：一個部署只有一個團隊網域，同一個 isolate 內重複請求共用抓到的 JWKS
let remoteKeySet: { url: string; keySet: JWTVerifyGetKey } | null = null;

function cachedRemoteKeySet(certsUrl: string): JWTVerifyGetKey {
  if (remoteKeySet?.url !== certsUrl) {
    remoteKeySet = {
      url: certsUrl,
      keySet: createRemoteJWKSet(new URL(certsUrl), { cacheMaxAge: JWKS_CACHE_MAX_AGE_MS }),
    };
  }
  return remoteKeySet.keySet;
}

function normalizeTeamDomain(teamDomain: string): string {
  return teamDomain.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
}

/**
 * 取得驗簽用的金鑰來源；設定不合法時丟出 Error（呼叫端 fail closed）。
 * 內嵌 JWKS 只在保留網域下採用；真實網域搭配內嵌 JWKS 視為設定錯誤。
 */
function resolveKeySet(team: string, jwksJson: string | undefined): JWTVerifyGetKey {
  if (team === LOCAL_TEAM_DOMAIN) {
    if (!jwksJson) throw new Error(`團隊網域是 ${LOCAL_TEAM_DOMAIN}，但沒有設定 ACCESS_JWKS_JSON`);
    return createLocalJWKSet(JSON.parse(jwksJson) as JSONWebKeySet);
  }
  if (!ACCESS_TEAM_DOMAIN_PATTERN.test(team)) {
    throw new Error(`ACCESS_TEAM_DOMAIN 不是合法的 Access 團隊網域：${team}`);
  }
  if (jwksJson) {
    throw new Error("真實團隊網域不得同時設定 ACCESS_JWKS_JSON（內嵌 JWKS 只給本機開發與測試）");
  }
  return cachedRemoteKeySet(`https://${team}/cdn-cgi/access/certs`);
}

/**
 * 建立 Access JWT 驗證器。任何一步失敗（缺設定、缺 JWT、簽章／aud／iss／exp 不符、沒有 email）
 * 都回傳同一個 `unauthorized`，不對呼叫端透露原因；原因只寫進 Workers Logs。
 */
export function createAccessVerifier(config: AccessConfig, clock: Clock) {
  return {
    async verify(jwt: unknown): Promise<AccessVerifyResult> {
      const team = normalizeTeamDomain(config.teamDomain ?? "");
      const audience = config.audience?.trim() ?? "";
      if (!team || !audience) {
        console.error(
          "Cloudflare Access 尚未設定（ACCESS_TEAM_DOMAIN / ACCESS_AUD 為空），管理 RPC 一律拒絕",
        );
        return fail("unauthorized");
      }
      if (typeof jwt !== "string" || jwt.length === 0) {
        return fail("unauthorized");
      }

      // 網址、金鑰來源與驗簽都在同一個 try 內：任何設定或 JWT 問題都 fail closed，不丟出 500
      try {
        const keySet = resolveKeySet(team, config.jwksJson);
        const { payload } = await jwtVerify(jwt, keySet, {
          algorithms: ["RS256"],
          issuer: `https://${team}`,
          audience,
          requiredClaims: ["exp"],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          currentDate: new Date(clock.now()),
        });
        const email = payload["email"];
        if (typeof email !== "string" || email.length === 0) {
          console.warn("Access JWT 沒有 email claim，拒絕");
          return fail("unauthorized");
        }
        return ok({ email });
      } catch (error) {
        console.error("Access 驗證失敗，拒絕", error instanceof Error ? error.message : error);
        return fail("unauthorized");
      }
    },
  };
}
