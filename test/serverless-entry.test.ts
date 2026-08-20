import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import handler from "../api/index.ts";
import { config } from "../src/config.ts";
import { startFixture } from "./fixture/server.ts";

/**
 * The serverless entry point. Two things decide whether this works on a platform
 * that invokes a handler per request instead of running a server: importing the
 * module must not bind a port, and the handler must route whatever path the
 * platform's rewrite hands it.
 */

/** Drive the handler exactly as a serverless platform would: one request, one call. */
function callHandler(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      http
        .get({ host: "127.0.0.1", port, path }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode ?? 0, body });
          });
        })
        .on("error", (error) => {
          server.close();
          reject(error);
        });
    });
  });
}

test("importing the entry point does not start a server", async () => {
  // If the module had called listen(), this port would already be taken. The whole
  // point of the serverless entry is that importing it has no side effect.
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(config.port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

test("the default export is a request handler, not an app that listens", () => {
  assert.equal(typeof handler, "function");
  // (req, res) — a serverless handler signature, not a server object.
  assert.equal(handler.length, 2);
});

test("serves /health at the bare path", async () => {
  const { status, body } = await callHandler("/health");
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).ok, true);
});

test("serves /health when the platform hands it the /api path", async () => {
  const { status, body } = await callHandler("/api/health");
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).ok, true);
});

test("runs a real scan through the handler, both path shapes", async () => {
  const fixture = await startFixture();
  const target = encodeURIComponent(fixture.origin);

  for (const path of [`/scan?url=${target}`, `/api/scan?url=${target}`]) {
    const { status, body } = await callHandler(path);
    assert.equal(status, 200, `${path} returned ${status}`);
    const parsed = JSON.parse(body) as { scores: { payable: string; readable: number } };
    assert.equal(parsed.scores.payable, "— roadmap");
    assert.ok(parsed.scores.readable > 0);
  }

  await fixture.close();
});

test("the 404 copy still reads correctly after prefix stripping", async () => {
  const { status, body } = await callHandler("/api/nope");
  assert.equal(status, 404);
  // "/nope", not "/api/nope" — the customer-facing message should name the route
  // they actually asked for, not our internal rewrite target.
  assert.match(JSON.parse(body).error, /nothing at \/nope/);
});

test("a bare /api request reaches the app as /", async () => {
  const { status } = await callHandler("/api");
  // No route is mounted at /, so this is the app's own 404 rather than a crash.
  assert.equal(status, 404);
});

test("the scan budget fits inside the function's declared maxDuration", async () => {
  const { readFile } = await import("node:fs/promises");
  const vercelConfig = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as {
    functions: Record<string, { maxDuration: number }>;
  };
  const maxDuration = vercelConfig.functions["api/index.ts"]?.maxDuration;
  assert.ok(maxDuration, "vercel.json should declare maxDuration for the function");
  assert.ok(
    config.scanTimeoutMs < maxDuration * 1000,
    `scan budget ${config.scanTimeoutMs}ms must leave room inside a ${maxDuration}s function limit`,
  );
});
