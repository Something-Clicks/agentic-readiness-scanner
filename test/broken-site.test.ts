import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runScan } from "../src/scan.ts";
import { renderText } from "../src/render/text.ts";

/**
 * The other end of the range: a JavaScript-only site with no structured data, no
 * sitemap, and a robots.txt that blocks the AI crawlers. This is the case the spec
 * says must be reported rather than worked around with a headless browser.
 */
const JS_ONLY = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loading…</title></head>
<body><div id="root"></div>
<noscript>You need to enable JavaScript to run this app.</noscript>
<script>window.__APP__={};</script></body></html>`;

const ROBOTS = `User-agent: ClaudeBot
Disallow: /

User-agent: PerplexityBot
Disallow: /

User-agent: OAI-SearchBot
Disallow: /

User-agent: *
Allow: /
`;

const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(ROBOTS);
    return;
  }
  if (path === "/sitemap.xml") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(JS_ONLY);
});

const origin = await new Promise<string>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
  });
});

const result = await runScan(origin);

test("reports the JavaScript dependency instead of routing around it", () => {
  const penalty = result.readable.penalties.find((entry) => entry.id === "readable.requires_javascript");
  assert.ok(penalty, "expected a JavaScript-dependency penalty");
  assert.ok(penalty.points > 0);
  assert.match(penalty.finding, /JavaScript/);
  assert.ok(result.limitations.some((limitation) => /do not run a browser/i.test(limitation)));
});

test("names the blocked crawlers and what they feed", () => {
  const access = result.discoverable.checks.find((check) => check.id === "discoverable.agent_access");
  assert.equal(access?.status, "partial");
  assert.match(access!.finding, /ClaudeBot/);
  assert.match(access!.finding, /PerplexityBot/);
  assert.match(access!.finding, /OAI-SearchBot/);
});

test("a site with nothing to read scores low but still returns a full report", () => {
  assert.ok(result.readable.score <= 10, `Readable was ${result.readable.score}`);
  assert.ok(result.callable.score <= 10, `Callable was ${result.callable.score}`);
  assert.equal(result.payable, "— roadmap");
  assert.equal(result.actions.length, 3);
  assert.ok(renderText(result, "full").includes("FULL REPORT"));
});

test("the biggest problem is stated in plain language, not check names", () => {
  assert.ok(result.biggestProblem.length > 20);
  assert.doesNotMatch(result.biggestProblem, /JSON-LD|schema\.org|openingHoursSpecification|structured data/);
});

test.after(() => {
  server.close();
});
