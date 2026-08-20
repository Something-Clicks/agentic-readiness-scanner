import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runScan } from "../src/scan.ts";
import { config } from "../src/config.ts";

/**
 * A scan runs synchronously inside one request, so its duration is the response's
 * duration. These cover the two ways that used to be unbounded: a site that stalls,
 * and a site that declares more sitemaps than anyone should probe.
 */

function listen(handler: http.RequestListener): Promise<{ origin: string; close: () => void; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close(), hits });
    });
  });
}

const HOME = `<!doctype html><html><head><title>Stall Co</title></head><body>
<h1>Stall Co</h1><p>Plumbing in Springfield. Call 555-123-4567.</p>
<a href="/services">Our services</a><a href="/contact">Get a quote</a><a href="/book">Book online</a>
</body></html>`;

// Answers the homepage, then never responds to anything else.
const stalling = await listen((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HOME);
  }
  // everything else: no response, ever
});

const startedAt = Date.now();
const stalled = await runScan(stalling.origin);
const elapsed = Date.now() - startedAt;

test("a stalling site cannot hold the scan open past its budget", () => {
  // Generous margin for the final in-flight fetch to unwind; the point is that this
  // is bounded at all, and nowhere near the ~135s it used to cost.
  assert.ok(
    elapsed < config.scanTimeoutMs + 4_000,
    `scan took ${elapsed}ms against a budget of ${config.scanTimeoutMs}ms`,
  );
});

test("the report names the work it skipped", () => {
  const skipped = stalled.limitations.filter((limitation) => /did not check/i.test(limitation));
  assert.ok(skipped.length > 0, "expected the report to say what it skipped");
  assert.ok(stalled.limitations.some((limitation) => /ran out of time|-second limit/i.test(limitation)));
});

test("an unchecked robots.txt is not scored as an open door", () => {
  const access = stalled.discoverable.checks.find((check) => check.id === "discoverable.agent_access");
  assert.ok(access, "expected the crawler-access check to be present");
  // Left out of the score entirely rather than awarded full marks.
  assert.equal(access.possible, 0);
  assert.equal(access.earned, 0);
  assert.doesNotMatch(access.finding, /lets all \d+ of the crawlers/);
});

test("pages that never answered count against response time, not for it", () => {
  const responseTime = stalled.discoverable.checks.find((check) => check.id === "discoverable.response_time");
  assert.ok(responseTime);
  assert.ok(responseTime.earned < responseTime.possible, "a stalling site must not score full marks on speed");
  assert.match(responseTime.finding, /never answered/);
});

test("the score reflects only what was actually verified", () => {
  const scored = stalled.discoverable.checks.filter((check) => check.possible > 0);
  const earned = scored.reduce((sum, check) => sum + check.earned, 0);
  const possible = scored.reduce((sum, check) => sum + check.possible, 0);
  assert.equal(stalled.discoverable.score, Math.round((earned / possible) * 100));
});

stalling.close();

// A site that answers fast but declares far more sitemaps than are worth probing.
const declared = 20;
const chatty = await listen((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/robots.txt") {
    const lines = ["User-agent: *", "Allow: /"];
    for (let i = 0; i < declared; i += 1) lines.push(`Sitemap: http://127.0.0.1:PORT/sitemap-${i}.xml`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(lines.join("\n").replaceAll("PORT", String(new URL(chattyOrigin).port)));
    return;
  }
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HOME);
    return;
  }
  // Every sitemap location answers 404 quickly, so time is never the limiting factor.
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
const chattyOrigin = chatty.origin;

const chattyResult = await runScan(chattyOrigin);

test("sitemap probing is capped by count, not just by time", () => {
  const fetchedSitemaps = chatty.hits.filter((path) => path.includes("sitemap"));
  assert.ok(
    fetchedSitemaps.length <= config.maxSitemapCandidates,
    `fetched ${fetchedSitemaps.length} sitemap locations, cap is ${config.maxSitemapCandidates}`,
  );
});

test("the skipped sitemap locations are reported, not silently dropped", () => {
  const sitemap = chattyResult.discoverable.checks.find((check) => check.id === "discoverable.sitemap");
  const notProbed = (sitemap?.evidence?.notProbed ?? []) as unknown[];
  assert.ok(notProbed.length > 0, "expected the unprobed locations to be listed");
  assert.ok(
    chattyResult.limitations.some((limitation) => /sitemap location/i.test(limitation)),
    "expected the report to mention the skipped sitemap locations",
  );
});

test("not finishing the sitemap search is not scored as having no sitemap", () => {
  const sitemap = chattyResult.discoverable.checks.find((check) => check.id === "discoverable.sitemap");
  assert.equal(sitemap?.possible, 0);
  assert.doesNotMatch(sitemap!.finding, /There is no sitemap/);
});

test.after(() => {
  chatty.close();
});
