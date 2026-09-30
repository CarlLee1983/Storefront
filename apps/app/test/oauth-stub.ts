import { exports } from "cloudflare:workers";
import { registerFetchRoute } from "./fetch-router";

export const ORIGIN = "http://localhost:4321";

const TOKEN_ENDPOINTS = ["https://oauth2.googleapis.com/token", "https://api.line.me/oauth2/v2.1/token"];

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

// Google 與 LINE 的 getUserInfo 都只 decode id_token、不驗簽，所以 alg: none 的假 JWT 就夠用
const fakeIdToken = (profile: Record<string, unknown>) =>
  `${base64Url({ alg: "none" })}.${base64Url(profile)}.sig`;

/** 攔截 provider 的 token endpoint，回傳帶指定 profile 的 id_token；其他請求照常送出。 */
function stubProviderProfile(profile: Record<string, unknown>) {
  registerFetchRoute(
    "oauth-provider",
    (url) => TOKEN_ENDPOINTS.some((endpoint) => url.startsWith(endpoint)),
    () =>
      Response.json({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: fakeIdToken(profile),
      }),
  );
}

export interface LoginResult {
  status: number;
  location: string | null;
  /** `name=value` 形式的 session cookie；登入被拒絕時為 undefined。 */
  sessionCookie: string | undefined;
}

/** 走完整的 OAuth 流程（發起登入 → provider 回呼），provider 端以 stub 取代。 */
export async function loginWith(
  provider: "google" | "line",
  profile: Record<string, unknown>,
  callbackURL = "/",
): Promise<LoginResult> {
  stubProviderProfile(profile);
  const app = exports.default;
  const start = await app.fetch(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ provider, callbackURL }),
    }),
  );
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  const cookie = start.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const callback = await app.fetch(
    new Request(`${ORIGIN}/api/auth/callback/${provider}?code=code&state=${state}`, {
      headers: { cookie },
      redirect: "manual",
    }),
  );
  return {
    status: callback.status,
    location: callback.headers.get("location"),
    sessionCookie: callback.headers
      .getSetCookie()
      .find((c) => c.includes("session_token"))
      ?.split(";")[0],
  };
}
