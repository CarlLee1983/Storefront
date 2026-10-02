import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { waitForOwnedChrome } from "./replay-browser.mjs";

const browserPath = "/devtools/browser/01234567-89ab-cdef-0123-456789abcdef";
function aliveChild() { return Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null }); }
async function profile(t, text) {
  const dir = await mkdtemp(join(tmpdir(), "storefront-91-owned-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "DevToolsActivePort"), text);
  return dir;
}
async function endpoint(t, pathname) {
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    assert.equal(request.url, "/json/version");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ Browser: "Chrome/154.0.8037.93", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}${pathname}` }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, hits: () => hits };
}

test("accepts the exact browser UUID and ephemeral port recorded in the owned profile", async t => {
  const api = await endpoint(t, browserPath);
  const dir = await profile(t, `${api.port}\n${browserPath}\n`);
  const result = await waitForOwnedChrome(aliveChild(), dir);
  assert.equal(result.webSocketUrl, `ws://127.0.0.1:${api.port}${browserPath}`);
  assert.equal(api.hits(), 1);
});

test("rejects a different browser UUID before the caller can connect", async t => {
  const api = await endpoint(t, "/devtools/browser/ffffffff-ffff-ffff-ffff-ffffffffffff");
  const dir = await profile(t, `${api.port}\n${browserPath}\n`);
  await assert.rejects(waitForOwnedChrome(aliveChild(), dir), /does not match/);
});

test("rejects malformed profile data without fetching an endpoint", async t => {
  const dir = await profile(t, "19229\nnot-a-browser\n");
  await assert.rejects(waitForOwnedChrome(aliveChild(), dir), /Invalid owned/);
});

test("rejects an already exited Chrome before reading or connecting", async t => {
  const dir = await profile(t, `19229\n${browserPath}\n`);
  const child = aliveChild(); child.exitCode = 1;
  await assert.rejects(waitForOwnedChrome(child, dir), /exited before/);
});

test("rejects Chrome exiting during the ownership handshake", async t => {
  const child = aliveChild();
  const server = createServer((_request, response) => {
    child.signalCode = "SIGTERM";
    response.end(JSON.stringify({ Browser: "Chrome/154", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}${browserPath}` }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dir = await profile(t, `${server.address().port}\n${browserPath}\n`);
  await assert.rejects(waitForOwnedChrome(child, dir), /exited before/);
});
