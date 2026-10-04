/**
 * E2E 的受測伺服器（Playwright 的 webServer 啟動它）：
 * 重建 E2E 專用的狀態 → 建置 Web → 對 App 與閘道各自的本機 D1 套用 migration → 產生管理者的 Access JWT 與內嵌 JWKS →
 * 寫入測試會員的 session → 以 `wrangler dev` 跑三個 Worker：Web + App 在同一個行程（PORT，Service Binding 才連得到），
 * 模擬閘道另一個行程（GATEWAY_PORT，瀏覽器與 App 都以 HTTP 連它，Web 的 webhook 也由它送回 BASE_URL）。
 *
 * 不碰開發者的本機狀態：兩個 D1 各放在 `.wrangler/e2e/state-app`、`.wrangler/e2e/state-gateway`；Web 建置到 `.wrangler/e2e/web`
 * （不覆寫 `apps/web/dist`）；各 Worker 的設定檔旁都放 E2E 自己的 `.dev.vars`（wrangler 只讀設定檔旁的 `.dev.vars`；
 * Astro 建置會把 `apps/web/.dev.vars` 複製到輸出目錄，所以建置後覆寫）。
 * 產生的設定檔只改路徑與 `BETTER_AUTH_URL`、`GATEWAY_BASE_URL`，其餘沿用各 Worker 的 wrangler.jsonc 頂層設定——
 * production 程式碼與設定都不為 E2E 修改（ADR 0013）。
 * 管理後台：E2E 跑的是 production 建置，`ACCESS_DEV_JWT` 在其中不會被讀取，所以不讓 Web 帶它；
 * 改由管理者的瀏覽器 context 送 `Cf-Access-Jwt-Assertion`（與 Cloudflare Access 相同），App 以內嵌 JWKS（`local.invalid`）驗簽。請勿改回 `ACCESS_DEV_JWT`。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { experimental_readRawConfig } from "wrangler";
import { createAdminAccess } from "./admin-access";
import { AUTH_SECRET, BASE_URL, GATEWAY_API_KEY, GATEWAY_INSPECTOR_PORT, GATEWAY_READY_TIMEOUT_MS, GATEWAY_PORT, GATEWAY_URL, GATEWAY_WEBHOOK_SECRET, MEMBER, PORT, SESSION, WEB_INSPECTOR_PORT } from "./constants";

const ROOT = resolve(import.meta.dirname, "../..");
const APP_DIR = join(ROOT, "apps/app");
const GATEWAY_DIR = join(ROOT, "apps/gateway");
const WEB_DIR = join(ROOT, "apps/web");
const E2E_DIR = join(ROOT, ".wrangler/e2e");
const APP_STATE = join(E2E_DIR, "state-app");
const GATEWAY_STATE = join(E2E_DIR, "state-gateway");
const APP_CONFIG = join(E2E_DIR, "app/wrangler.json");
const GATEWAY_CONFIG = join(E2E_DIR, "gateway/wrangler.json");
const WEB_OUT = join(E2E_DIR, "web");
const DAY_MS = 86_400_000;

type RawConfig = Record<string, unknown> & {
  main?: string;
  vars?: Record<string, string>;
  d1_databases?: { database_name: string; migrations_dir: string }[];
};

function run(cmd: string[], cwd: string): void {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`E2E 準備失敗（exit ${result.exitCode}）：${cmd.join(" ")}`);
}

/** 某個 Worker 的 E2E 設定：頂層設定（不含 preview／production 環境），路徑改成絕對路徑，`vars` 可覆寫。 */
function writeWorkerConfig(dir: string, outFile: string, vars: Record<string, string>, devVars: string[]): string {
  const { rawConfig } = experimental_readRawConfig({ config: join(dir, "wrangler.jsonc") });
  const { env: _environments, $schema: _schema, ...topLevel } = rawConfig as RawConfig;
  if (!topLevel.main || !topLevel.d1_databases) {
    throw new Error(`${dir}/wrangler.jsonc 缺少 main 或 d1_databases，無法產生 E2E 設定`);
  }
  const config = {
    ...topLevel,
    main: join(dir, topLevel.main),
    vars: { ...topLevel.vars, ...vars },
    d1_databases: topLevel.d1_databases.map((db) => ({ ...db, migrations_dir: join(dir, db.migrations_dir) })),
  };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(config, null, 2));
  writeFileSync(join(dirname(outFile), ".dev.vars"), devVars.join("\n"));
  return topLevel.d1_databases[0]!.database_name;
}

/** 對某個 Worker 的本機 D1 執行 `wrangler d1 <command> <資料庫> ...`。 */
function d1(dir: string, config: string, state: string, database: string, command: string[], options: string[] = []): void {
  run(["bunx", "wrangler", "d1", ...command, database, "--local", "-c", config, "--persist-to", state, ...options], dir);
}

/** 測試會員、session 與已驗證的聯絡 email（結帳的前提）直接寫入 App 的 D1，取代社群登入（ADR 0013）。值都是 constants.ts 的常數（不含單引號），直接內插。 */
function insertMemberSession(database: string): void {
  const now = Date.now();
  const sql = `
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('${MEMBER.id}', '${MEMBER.name}', '${MEMBER.email}', 0, ${now}, ${now});
    INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
      VALUES ('${SESSION.id}', ${now + DAY_MS}, '${SESSION.token}', ${now}, ${now}, '${MEMBER.id}');
    INSERT INTO contact_verifications (customer_id, email, token, created_at, expires_at, verified_at)
      VALUES ('${MEMBER.id}', '${MEMBER.contactEmail}', 'e2e-member-contact-token', ${now}, ${now + DAY_MS}, ${now});`;
  d1(APP_DIR, APP_CONFIG, APP_STATE, database, ["execute"], ["--command", sql]);
}

const PORTS = [PORT, GATEWAY_PORT, WEB_INSPECTOR_PORT, GATEWAY_INSPECTOR_PORT];

/** 有行程在聽這個埠就回 true（IPv4 與 IPv6 各試一次，wrangler 可能綁在任一個）。 */
async function isPortBusy(port: number): Promise<boolean> {
  const tryConnect = (host: string) =>
    new Promise<boolean>((resolvePort) => {
      const socket = connect({ port, host });
      socket.once("connect", () => (socket.destroy(), resolvePort(true)));
      socket.once("error", () => (socket.destroy(), resolvePort(false)));
    });
  return (await tryConnect("127.0.0.1")) || (await tryConnect("::1"));
}

async function busyPorts(): Promise<number[]> {
  const busy = await Promise.all(PORTS.map(isPortBusy));
  return PORTS.filter((_, i) => busy[i]);
}

/** 閘道在沒有對應路徑時也會回應（404 之類），只要連得上就算啟動完成；行程先結束就立刻失敗，不必等到逾時。 */
async function waitForGateway(gateway: Subprocess): Promise<void> {
  let exited = false;
  void gateway.exited.then(() => (exited = true));
  const deadline = Date.now() + GATEWAY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error("模擬閘道在就緒前就結束了，原因見上方 wrangler 輸出");
    try {
      await fetch(`${GATEWAY_URL}/pay/ready-check`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`模擬閘道在 ${GATEWAY_URL} 逾時未啟動（${GATEWAY_READY_TIMEOUT_MS} ms）`);
}

// 子行程各自獨立成行程群組（detached）：bunx → wrangler → workerd 是一整串，只殺第一層會留下 workerd；
// 殺整個群組（process.kill(-pid)）才收得乾淨。所以一 spawn 就要登記，任何後續失敗都走 stopAll。
const children: Subprocess[] = [];
function spawnWorker(cmd: string[], cwd: string): Subprocess {
  // X_LOCAL_EXPLORER：夾具（customer-fixture.ts）依賴 wrangler dev 的 Local Explorer 實驗端點，明確開啟而不靠預設值；關閉遙測避免測試連外
  const child = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", detached: true, env: { ...process.env, X_LOCAL_EXPLORER: "true", WRANGLER_SEND_METRICS: "false" } });
  children.push(child);
  return child;
}

async function stopAll(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  for (const child of children) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // 群組已經不存在
    }
  }
  await Promise.race([Promise.all(children.map((child) => child.exited)), Bun.sleep(10_000)]);
  // 行程結束不代表埠已釋放（workerd 可能稍後才退出）：最多等 10 秒確認，確認不了要大聲說
  const deadline = Date.now() + 10_000;
  let busy = await busyPorts();
  while (busy.length > 0 && Date.now() < deadline) {
    await Bun.sleep(200);
    busy = await busyPorts();
  }
  if (busy.length > 0) console.error(`E2E 結束後埠仍被佔用：${busy.join(", ")}（可能有殘留的 wrangler／workerd 行程）`);
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    void stopAll(signal).then(() => process.exit(0));
  });
}

const busyAtStart = await busyPorts();
if (busyAtStart.length > 0) {
  console.error(`E2E 需要的埠已被佔用：${busyAtStart.join(", ")}。請先結束佔用它們的行程（例如 \`lsof -i :${busyAtStart[0]}\`）。`);
  process.exit(1);
}

try {
  rmSync(E2E_DIR, { recursive: true, force: true });

  const appDatabase = writeWorkerConfig(
    APP_DIR,
    APP_CONFIG,
    { BETTER_AUTH_URL: BASE_URL, GATEWAY_BASE_URL: GATEWAY_URL },
    [
      `BETTER_AUTH_SECRET=${AUTH_SECRET}`,
      // OAuth 的值只需非空：E2E 不走 OAuth，但缺少時 App 會把整個會員登入判為不可用
      "GOOGLE_CLIENT_ID=e2e",
      "GOOGLE_CLIENT_SECRET=e2e",
      "LINE_CHANNEL_ID=e2e",
      "LINE_CHANNEL_SECRET=e2e",
      `GATEWAY_API_KEY=${GATEWAY_API_KEY}`,
      ...(await createAdminAccess()),
    ],
  );
  const gatewayDatabase = writeWorkerConfig(GATEWAY_DIR, GATEWAY_CONFIG, {}, [
    `GATEWAY_API_KEY=${GATEWAY_API_KEY}`,
    `GATEWAY_WEBHOOK_SECRET=${GATEWAY_WEBHOOK_SECRET}`,
  ]);

  run(["bunx", "astro", "build", "--outDir", WEB_OUT], WEB_DIR);
  writeFileSync(join(WEB_OUT, "server/.dev.vars"), `GATEWAY_WEBHOOK_SECRET=${GATEWAY_WEBHOOK_SECRET}\n`);

  d1(APP_DIR, APP_CONFIG, APP_STATE, appDatabase, ["migrations", "apply"]);
  d1(GATEWAY_DIR, GATEWAY_CONFIG, GATEWAY_STATE, gatewayDatabase, ["migrations", "apply"]);
  insertMemberSession(appDatabase);

  const gateway = spawnWorker(
    ["bunx", "wrangler", "dev", "-c", GATEWAY_CONFIG, "--persist-to", GATEWAY_STATE, "--port", String(GATEWAY_PORT), "--inspector-port", String(GATEWAY_INSPECTOR_PORT), "--show-interactive-dev-session=false"],
    GATEWAY_DIR,
  );
  // 等閘道就緒再啟動 Web：兩個 wrangler dev 同時起來時，啟動日誌與失敗原因會混在一起，難以判讀
  await waitForGateway(gateway);
  const web = spawnWorker(
    [
      "bunx", "wrangler", "dev",
      "-c", join(WEB_OUT, "server/wrangler.json"),
      "-c", APP_CONFIG,
      "--persist-to", APP_STATE,
      "--port", String(PORT),
      "--inspector-port", String(WEB_INSPECTOR_PORT),
      "--show-interactive-dev-session=false",
    ],
    WEB_DIR,
  );

  // 任一個 Worker 結束就整體結束：被訊號終止時 exitCode 不是 0，照實回報，不讓 Playwright 當成正常結束
  const exitCode = await Promise.race(children.map((child) => child.exited));
  await stopAll();
  process.exit(stopping || exitCode === 0 ? 0 : exitCode || 1);
} catch (error) {
  // 任何一步失敗（含閘道啟動失敗）都先收掉已啟動的子行程，不留孤兒
  console.error(error);
  await stopAll();
  process.exit(1);
}
