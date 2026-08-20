import { config } from "../config.ts";
import type { CheckResult, CheckStatus, PageSummary, PillarResult } from "../types.ts";
import type { RobotsReport, SitemapReport } from "./robots.ts";
import { listPhrase } from "./readable.ts";

/**
 * DISCOVERABLE — can the crawlers that feed search and AI answers actually get in?
 *
 * Weighted sum, 100 points. Each check is reported individually so the $30 gap
 * report can cite the specific rule, URL, or status code behind the number.
 */
const WEIGHTS = {
  agentAccess: 35,
  sitemap: 25,
  reachability: 25,
  responseTime: 15,
} as const;

export function scoreDiscoverable(
  robots: RobotsReport,
  sitemap: SitemapReport,
  pages: PageSummary[],
): PillarResult {
  const checks: CheckResult[] = [
    checkAgentAccess(robots),
    checkRobotsFile(robots),
    checkSitemap(sitemap, robots),
    checkReachability(pages),
    checkResponseTime(pages),
  ];

  const earned = checks.reduce((sum, check) => sum + check.earned, 0);
  const possible = checks.reduce((sum, check) => sum + check.possible, 0);

  return {
    name: "DISCOVERABLE",
    // Checks reported but not scored carry possible = 0 — either by design
    // (checkRobotsFile) or because we could not run them. Scoring over the weight we
    // actually verified rescales the pillar instead of counting unchecked as failed.
    score: possible === 0 ? 0 : Math.max(0, Math.min(100, Math.round((earned / possible) * 100))),
    checks,
    penalties: [],
  };
}

function checkAgentAccess(robots: RobotsReport): CheckResult {
  const possible = WEIGHTS.agentAccess;

  // We never read robots.txt, so we know nothing about who is allowed in. Score it
  // out of zero rather than out of 35: an unchecked crawler is not an allowed one,
  // and awarding full marks here would be the most misleading thing this report
  // could do. Dropping the weight rescales the pillar over what we did verify.
  if (!robots.checked) {
    return {
      id: "discoverable.agent_access",
      label: "Crawler access in robots.txt",
      earned: 0,
      possible: 0,
      status: "partial",
      finding:
        "We did not get to robots.txt before this scan ran out of time, so we cannot say which crawlers are allowed in. This check is left out of the score rather than guessed at.",
      recommendation: "Run the scan again. If it keeps timing out, the site is slow enough that crawlers will struggle with it too.",
      evidence: { robotsTxtUrl: robots.url, checked: false },
    };
  }

  const blocked = robots.agentAccess.filter((access) => !access.homepageAllowed);
  const partiallyBlocked = robots.agentAccess.filter(
    (access) => access.homepageAllowed && access.disallowedPaths.length > 0,
  );

  const total = robots.agentAccess.length;
  const fullyAllowed = total - blocked.length;
  let earned = (fullyAllowed / total) * possible;
  earned -= (partiallyBlocked.length / total) * possible * 0.4;

  const slowCrawl = robots.agentAccess.filter(
    (access) => access.crawlDelay !== null && access.crawlDelay >= 10,
  );
  if (slowCrawl.length > 0) earned -= possible * 0.1;

  let finding: string;
  let recommendation: string | undefined;

  if (blocked.length === 0 && partiallyBlocked.length === 0) {
    finding = `Your robots.txt lets all ${total} of the crawlers we check reach the site: ${robots.agentAccess.map((a) => a.agent).join(", ")}.`;
  } else if (blocked.length > 0) {
    finding =
      `Your robots.txt blocks ${listPhrase(blocked.map((a) => a.agent))} from the homepage. ` +
      `${blocked.length === 1 ? "That crawler feeds" : "Those crawlers feed"} ${listPhrase([...new Set(blocked.map((a) => a.operator))])}. ` +
      `When someone asks one of those systems for a business like yours, you are not in the pool it answers from.`;
    recommendation = `Remove the Disallow rules for ${listPhrase(blocked.map((a) => a.agent))} in robots.txt, unless you are blocking them on purpose.`;
  } else {
    const paths = [...new Set(partiallyBlocked.flatMap((a) => a.disallowedPaths))];
    finding =
      `Crawlers can reach your homepage, but robots.txt blocks ${listPhrase(partiallyBlocked.map((a) => a.agent))} from ${paths.length} of the pages we scanned: ${paths.join(", ")}.`;
    recommendation = `Check whether those Disallow rules are intentional. If a blocked page is where people book or get a quote, that is the page you most want read.`;
  }

  if (slowCrawl.length > 0) {
    const worst = Math.max(...slowCrawl.map((a) => a.crawlDelay ?? 0));
    finding += ` robots.txt also sets a crawl delay of ${worst} seconds for ${listPhrase(slowCrawl.map((a) => a.agent))}, which slows how much of the site gets read.`;
  }

  return {
    id: "discoverable.agent_access",
    label: "Crawler access in robots.txt",
    earned: clamp(Math.round(earned), possible),
    possible,
    status: statusFor(earned, possible),
    finding,
    recommendation,
    evidence: {
      robotsTxtUrl: robots.url,
      robotsTxtExists: robots.exists,
      agents: robots.agentAccess,
      note:
        "Access is read from the site's robots.txt rules for each named agent. This scanner does not send another platform's user agent — every request in this scan identifies itself as " +
        `${config.userAgent}.`,
    },
  };
}

/** Reported for the gap report, not scored — the access check above carries the points. */
function checkRobotsFile(robots: RobotsReport): CheckResult {
  let finding: string;
  let recommendation: string | undefined;
  let status: CheckStatus = "pass";

  if (!robots.checked) {
    finding = "We did not read robots.txt — the scan ran out of time first.";
    recommendation = "Run the scan again to check it.";
    status = "partial";
  } else if (robots.contentTypeWarning) {
    finding = robots.contentTypeWarning;
    recommendation = "Serve /robots.txt as plain text, or remove the catch-all route that is answering for it.";
    status = "partial";
  } else if (!robots.exists && robots.status === 404) {
    finding =
      "There is no robots.txt on the site. Nothing is blocked, which is fine, but you also have nowhere to point crawlers at your sitemap.";
    recommendation = "Add a robots.txt with a Sitemap: line pointing at your sitemap.";
    status = "partial";
  } else if (!robots.exists) {
    finding = `We could not read /robots.txt${robots.status ? ` (HTTP ${robots.status})` : robots.fetchError ? ` — ${robots.fetchError}` : ""}.`;
    recommendation = "Make /robots.txt return a plain text file with a 200.";
    status = "partial";
  } else if (robots.blocksEverything) {
    finding = "Your robots.txt disallows every crawler we check, across the whole site.";
    recommendation = "If the site is meant to be found, remove the site-wide Disallow.";
    status = "fail";
  } else {
    finding = `robots.txt is present and readable at ${robots.url}.`;
  }

  return {
    id: "discoverable.robots_file",
    label: "robots.txt present and readable",
    earned: 0,
    possible: 0,
    status,
    finding,
    recommendation,
    evidence: { url: robots.url, status: robots.status, exists: robots.exists, body: robots.body.slice(0, 2_000) },
  };
}

function checkSitemap(sitemap: SitemapReport, robots: RobotsReport): CheckResult {
  const possible = WEIGHTS.sitemap;

  if (!sitemap.found) {
    // "We looked everywhere and found nothing" is a finding. "We stopped looking"
    // is not the same thing, and must not be scored as one.
    const unfinished = sitemap.notProbed.length > 0;
    if (unfinished) {
      const outOfTime = sitemap.notProbed.some((entry) => /ran out of time/.test(entry.reason));
      return {
        id: "discoverable.sitemap",
        label: "Sitemap",
        earned: 0,
        possible: 0,
        status: "partial",
        finding:
          `We checked ${sitemap.attempts.length} sitemap location${sitemap.attempts.length === 1 ? "" : "s"} without finding one, and left ${sitemap.notProbed.length} unchecked ` +
          `${outOfTime ? "when the scan ran out of time" : "because this scan probes a fixed number of locations"}. ` +
          "Since we did not finish looking, this is left out of the score rather than counted as a missing sitemap.",
        recommendation:
          "Point robots.txt at your sitemap with a single Sitemap: line so it is found on the first look.",
        evidence: { attempts: sitemap.attempts, notProbed: sitemap.notProbed, candidatesDeclared: sitemap.candidatesDeclared },
      };
    }
    return {
      id: "discoverable.sitemap",
      label: "Sitemap",
      earned: 0,
      possible,
      status: "fail",
      finding:
        "There is no sitemap we could find. Crawlers have to discover your pages by following links, so anything that is not linked from the homepage may never be read.",
      recommendation:
        "Publish a sitemap.xml listing every page you want found, and add a Sitemap: line to robots.txt pointing at it.",
      evidence: { attempts: sitemap.attempts, candidatesDeclared: sitemap.candidatesDeclared },
    };
  }

  let earned = possible;
  const notes: string[] = [];

  if (sitemap.discoveredVia !== "robots.txt") {
    earned -= possible * 0.2;
    notes.push("It is not referenced from robots.txt, so a crawler only finds it by guessing the filename.");
  }
  if (!sitemap.parsed) {
    earned -= possible * 0.5;
    notes.push(sitemap.error ?? "It did not parse cleanly.");
  }
  if (sitemap.parsed && !sitemap.isIndex && sitemap.urlCount === 0) {
    earned -= possible * 0.5;
    notes.push("It lists no URLs.");
  }

  const count = sitemap.isIndex
    ? `${sitemap.childSitemapCount} child sitemap${sitemap.childSitemapCount === 1 ? "" : "s"}`
    : `${sitemap.urlCount} URL${sitemap.urlCount === 1 ? "" : "s"}`;

  return {
    id: "discoverable.sitemap",
    label: "Sitemap",
    earned: clamp(Math.round(earned), possible),
    possible,
    status: statusFor(earned, possible),
    finding: `A sitemap is published at ${sitemap.url} listing ${count}.${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`,
    recommendation:
      sitemap.discoveredVia !== "robots.txt"
        ? `Add "Sitemap: ${sitemap.url}" to robots.txt.`
        : !sitemap.parsed
          ? "Fix the sitemap XML so it validates — a sitemap that does not parse is skipped."
          : undefined,
    evidence: {
      url: sitemap.url,
      discoveredVia: sitemap.discoveredVia,
      parsed: sitemap.parsed,
      urlCount: sitemap.urlCount,
      isIndex: sitemap.isIndex,
      childSitemapCount: sitemap.childSitemapCount,
      robotsSitemapLines: robots.sitemapUrls,
      attempts: sitemap.attempts,
    },
  };
}

function checkReachability(pages: PageSummary[]): CheckResult {
  const possible = WEIGHTS.reachability;
  const blocked = pages.filter((page) => page.blockSignal);
  const failed = pages.filter((page) => page.error || (page.status !== null && page.status >= 400));
  const problems = [...new Set([...blocked, ...failed])];

  const earned = pages.length === 0 ? 0 : possible * (1 - problems.length / pages.length);

  if (problems.length === 0) {
    return {
      id: "discoverable.reachability",
      label: "Pages served without a block",
      earned: possible,
      possible,
      status: "pass",
      finding: `All ${pages.length} page${pages.length === 1 ? "" : "s"} we requested came back as real pages — no refusals, no challenge screens.`,
      evidence: { pages },
    };
  }

  const details = problems
    .map((page) => `${page.url} — ${page.blockSignal ?? page.error ?? `HTTP ${page.status}`}`)
    .join("; ");

  return {
    id: "discoverable.reachability",
    label: "Pages served without a block",
    earned: clamp(Math.round(earned), possible),
    possible,
    status: statusFor(earned, possible),
    finding:
      `${problems.length} of the ${pages.length} pages we requested did not come back as a real page: ${details}. ` +
      `We asked politely, with a user agent that says who we are. A protection rule that stops us stops the search and AI crawlers the same way.`,
    recommendation:
      "Check your firewall or bot-protection rules and allow well-behaved crawlers through. If a challenge screen is the first thing a crawler sees, that is the only thing it indexes.",
    evidence: { pages },
  };
}

function checkResponseTime(pages: PageSummary[]): CheckResult {
  const possible = WEIGHTS.responseTime;

  // A page that never answered is not missing data — it is the worst response time
  // there is. Excluding timeouts here would mean a site that stalls on everything
  // scores better than one that is merely slow.
  const answered = pages.filter((page) => page.status !== null);
  const timedOut = pages.filter((page) => page.status === null && page.error);

  if (answered.length === 0 && timedOut.length === 0) {
    return {
      id: "discoverable.response_time",
      label: "Response time",
      earned: 0,
      possible,
      status: "fail",
      finding: "Nothing responded, so there is no response time to measure.",
      evidence: { pages },
    };
  }

  if (answered.length === 0) {
    return {
      id: "discoverable.response_time",
      label: "Response time",
      earned: 0,
      possible,
      status: "fail",
      finding: `None of the ${timedOut.length} pages we requested answered before we gave up waiting. A crawler does not wait longer than we did.`,
      recommendation:
        "Get first-byte time under a second — caching, a CDN, or fewer server-side calls before the HTML starts sending.",
      evidence: { pages },
    };
  }

  const slowest = Math.max(...answered.map((page) => page.elapsedMs));
  const average = Math.round(answered.reduce((sum, page) => sum + page.elapsedMs, 0) / answered.length);
  const verySlow = answered.filter((page) => page.elapsedMs >= config.verySlowResponseMs);
  const slow = answered.filter(
    (page) => page.elapsedMs >= config.slowResponseMs && page.elapsedMs < config.verySlowResponseMs,
  );

  const total = answered.length + timedOut.length;
  let earned = possible;
  // A timeout costs the full share for that page.
  earned -= (timedOut.length / total) * possible;
  earned -= (verySlow.length / total) * possible;
  earned -= (slow.length / total) * possible * 0.5;

  if (timedOut.length === 0 && verySlow.length === 0 && slow.length === 0) {
    return {
      id: "discoverable.response_time",
      label: "Response time",
      earned: possible,
      possible,
      status: "pass",
      finding: `Pages came back in ${duration(average)} on average, slowest ${duration(slowest)}. Fast enough that a crawler working through a budget will finish the page.`,
      evidence: { averageMs: average, slowestMs: slowest, timedOut: timedOut.length, pages },
    };
  }

  const parts: string[] = [];
  if (timedOut.length > 0) {
    parts.push(
      `${timedOut.length} of ${total} pages never answered at all (${timedOut.map((page) => page.url).join(", ")})`,
    );
  }
  const slowCount = verySlow.length + slow.length;
  if (slowCount > 0) {
    parts.push(
      `${slowCount} of ${total} took over ${duration(config.slowResponseMs)} to respond (slowest ${duration(slowest)}, on ${answered.find((page) => page.elapsedMs === slowest)?.url})`,
    );
  }

  return {
    id: "discoverable.response_time",
    label: "Response time",
    earned: clamp(Math.round(earned), possible),
    possible,
    status: statusFor(earned, possible),
    finding:
      `${parts.join(", and ")}. ` +
      `Crawlers work through a fixed budget of time per site. Slow pages get abandoned partway, and a half-read page is indexed as a half-read page.`,
    recommendation:
      "Get first-byte time under a second — caching, a CDN, or fewer server-side calls before the HTML starts sending.",
    evidence: { averageMs: average, slowestMs: slowest, timedOut: timedOut.length, pages },
  };
}

/** Sub-second timings read as "0.0 seconds", which looks like a bug. Show milliseconds. */
function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)} seconds`;
}

function statusFor(earned: number, possible: number): CheckStatus {
  const ratio = possible === 0 ? 0 : earned / possible;
  if (ratio >= 0.9) return "pass";
  if (ratio > 0) return "partial";
  return "fail";
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}
