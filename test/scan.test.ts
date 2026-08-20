import { test } from "node:test";
import assert from "node:assert/strict";
import { startFixture } from "./fixture/server.ts";
import { runScan, normalizeUrl, ScanError } from "../src/scan.ts";
import { renderText } from "../src/render/text.ts";
import { shapeReport } from "../src/render/report.ts";
import type { ScanResult } from "../src/types.ts";

const fixture = await startFixture();
let result: ScanResult;

test("scans a well-built local business site end to end", async () => {
  result = await runScan(fixture.origin);
  assert.equal(result.finalUrl, `${fixture.origin}/`);
});

test("reads the homepage plus key pages", () => {
  const roles = result.pagesFetched.map((page) => page.role);
  assert.ok(roles.includes("homepage"));
  assert.ok(roles.includes("services") || roles.includes("contact") || roles.includes("booking"));
});

test("every request went out as SCAN_USER_AGENT, never another crawler's identity", () => {
  assert.match(result.userAgent, /SomethingClicks/i);
  assert.doesNotMatch(result.userAgent, /googlebot|claudebot|perplexitybot|gptbot/i);
});

test("scores all three pillars in range", () => {
  for (const pillar of [result.readable, result.discoverable, result.callable]) {
    assert.ok(pillar.score >= 0 && pillar.score <= 100, `${pillar.name} = ${pillar.score}`);
  }
});

test("a site with full structured data scores high on Readable and Callable", () => {
  assert.ok(result.readable.score >= 85, `Readable was ${result.readable.score}`);
  assert.ok(result.callable.score >= 85, `Callable was ${result.callable.score}`);
  assert.ok(result.discoverable.score >= 90, `Discoverable was ${result.discoverable.score}`);
});

test("Callable is the five-step task path, each step out of 20", () => {
  assert.equal(result.callable.steps.length, 5);
  assert.deepEqual(result.callable.steps.map((step) => step.step), [1, 2, 3, 4, 5]);
  for (const step of result.callable.steps) {
    assert.equal(step.possible, 20);
    assert.ok(step.earned >= 0 && step.earned <= 20);
  }
  assert.equal(
    result.callable.score,
    result.callable.steps.reduce((sum, step) => sum + step.earned, 0),
  );
});

test("Payable is never scored", () => {
  assert.equal(result.payable, "— roadmap");
  const free = shapeReport(result, "free") as { scores: { payable: string } };
  assert.equal(free.scores.payable, "— roadmap");
  const full = shapeReport(result, "full") as { detail: { payable: { score: null } } };
  assert.equal(full.detail.payable.score, null);
});

test("actions list what is actually left to fix, at most three", () => {
  assert.ok(result.actions.length <= 3);
  const gaps = [...result.readable.checks, ...result.discoverable.checks, ...result.callable.checks].filter(
    (check) => check.possible > 0 && check.earned < check.possible,
  ).length + result.readable.penalties.length + result.discoverable.penalties.length;
  if (gaps === 0) assert.equal(result.actions.length, 0);
  else assert.ok(result.actions.length >= 1);
});

test("does not claim a task-path break when the path holds up", () => {
  if (result.callable.breaksAt.earned >= 18) {
    assert.doesNotMatch(result.biggestProblem, /cannot work out what services/i);
  }
  // Whatever it reports, it must be one sentence a business owner would recognise,
  // not the name of a check.
  assert.doesNotMatch(result.biggestProblem, /JSON-LD|schema\.org|openingHoursSpecification|areaServed|robots\.txt/);
});

test("free-tier text matches the layout in build-spec.md", () => {
  const text = renderText(result, "free");
  const lines = text.split("\n");
  assert.equal(lines[0], "SOMETHING CLICKS — AGENTIC READINESS");
  assert.equal(lines[1], "");
  assert.match(lines[2]!, /^READABLE {7}\d{1,3}\/100$/);
  assert.match(lines[3]!, /^DISCOVERABLE {3}\d{1,3}\/100$/);
  assert.match(lines[4]!, /^CALLABLE {7}\d{1,3}\/100$/);
  assert.equal(lines[5], "PAYABLE        — roadmap");
  assert.equal(lines[6], "");
  assert.equal(lines[7], "BIGGEST PROBLEM");
  assert.ok(text.includes("\nACTIONS\n"));
});

test("free tier withholds the itemized detail, full tier includes it", () => {
  const free = shapeReport(result, "free");
  assert.equal(free.detail, undefined);
  assert.equal(free.prioritizedGaps, undefined);
  assert.equal(free.fullReportAvailable, true);

  const full = shapeReport(result, "full") as { detail: Record<string, unknown>; prioritizedGaps: unknown[] };
  assert.ok(full.detail.readable);
  assert.ok(full.detail.discoverable);
  assert.ok(full.detail.callable);
  assert.ok(Array.isArray(full.prioritizedGaps));
});

test("every check carries its own finding, so the gap report can cite specifics", () => {
  const checks = [...result.readable.checks, ...result.discoverable.checks, ...result.callable.checks];
  assert.ok(checks.length >= 12);
  for (const check of checks) {
    assert.ok(check.finding.length > 20, `${check.id} has no finding`);
    assert.ok(check.earned <= check.possible || check.possible === 0);
  }
});

test("reports robots.txt-derived access for every named crawler", () => {
  const access = result.discoverable.checks.find((check) => check.id === "discoverable.agent_access");
  const agents = (access?.evidence?.agents ?? []) as Array<{ agent: string }>;
  assert.deepEqual(
    agents.map((entry) => entry.agent),
    ["Googlebot", "OAI-SearchBot", "ClaudeBot", "Claude-SearchBot", "Claude-User", "PerplexityBot"],
  );
});

test("finds the sitemap through robots.txt", () => {
  const sitemap = result.discoverable.checks.find((check) => check.id === "discoverable.sitemap");
  assert.equal(sitemap?.status, "pass");
  assert.equal((sitemap?.evidence as { discoveredVia: string }).discoveredVia, "robots.txt");
  assert.equal((sitemap?.evidence as { urlCount: number }).urlCount, 4);
});

test("normalizes bare hostnames and rejects nonsense", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.equal(normalizeUrl(" https://Example.com/path "), "https://example.com/path");
  assert.throws(() => normalizeUrl(""), ScanError);
  assert.throws(() => normalizeUrl("localhost"), ScanError);
  assert.throws(() => normalizeUrl("ftp://example.com"), ScanError);
});

test("error copy says what happened and what to do, without jargon", () => {
  try {
    normalizeUrl("not a url at all");
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof ScanError);
    assert.ok(error.detail.recommendation);
    assert.doesNotMatch(error.message, /unlock|supercharge|leverage|synerg/i);
  }
});

test.after(async () => {
  await fixture.close();
});
