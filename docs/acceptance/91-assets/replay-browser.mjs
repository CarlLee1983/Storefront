import { readFile } from "node:fs/promises";
import { join } from "node:path";

function assertAlive(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error("Owned Chrome exited before connection.");
}

// Read only the fresh profile created for this child; never discover a browser by a fixed port.
export async function waitForOwnedChrome(child, profile) {
  const deadline = Date.now() + 20_000;
  let spawnError;
  const onError = error => { spawnError = error; };
  child.on("error", onError);
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assertAlive(child);
      let contents;
      try { contents = await readFile(join(profile, "DevToolsActivePort"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (contents !== undefined) {
        const lines = contents.trim().split("\n");
        const port = Number(lines[0]);
        if (lines.length !== 2 || !/^\d+$/.test(lines[0]) || !Number.isInteger(port) || port < 1 || port > 65535 ||
          !/^\/devtools\/browser\/[0-9a-f-]{36}$/i.test(lines[1])) throw new Error("Invalid owned DevToolsActivePort.");
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { redirect: "error", signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error("Owned Chrome version endpoint failed.");
        const version = await response.json();
        const ws = new URL(version.webSocketDebuggerUrl);
        if (!String(version.Browser).startsWith("Chrome/") || ws.protocol !== "ws:" || ws.hostname !== "127.0.0.1" ||
          Number(ws.port) !== port || ws.pathname !== lines[1] || ws.search || ws.hash || ws.username || ws.password) {
          throw new Error("Chrome endpoint does not match the owned profile.");
        }
        assertAlive(child);
        return { version: version.Browser, port, webSocketUrl: ws.href };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Owned Chrome endpoint did not become ready.");
  } finally { child.off("error", onError); }
}
