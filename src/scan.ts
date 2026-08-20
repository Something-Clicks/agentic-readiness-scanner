import { config, PAYABLE_LINE } from "./config.ts";
import { crawl } from "./crawl.ts";
import { extractBusinessFacts } from "./extract/business.ts";
import { scoreReadable } from "./checks/readable.ts";
import { scoreDiscoverable } from "./checks/discoverable.ts";
import { scoreCallable } from "./checks/callable.ts";
import { checkRobots, checkSitemap } from "./checks/robots.ts";
import { biggestProblem, buildActions } from "./render/narrative.ts";
import type { PageSummary, ScanResult } from "./types.ts";

/** A scan that could not run at all, with a plain explanation of why. */
export class ScanError extends Error {
  readonly detail: { url: string; recommendation?: string; status?: number | null };

  constructor(message: string, detail: { url: string; recommendation?: string; status?: number | null }) {
    super(message);
    this.name = "ScanError";
    this.detail = detail;
  }
}

/**
 * Normalize what a person types into something fetchable. "joesplumbing.com",
 * "www.joesplumbing.com/", and "https://joesplumbing.com" all mean the same thing.
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ScanError("No web address was given.", {
      url: input,
      recommendation: "Send a URL, like https://example.com.",
    });
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ScanError(`"${trimmed}" is not a web address we can read.`, {
      url: input,
      recommendation: "Include the full address, like https://example.com.",
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ScanError(`We can only scan http and https addresses. This one is ${parsed.protocol.replace(":", "")}.`, {
      url: input,
      recommendation: "Send the site's web address, like https://example.com.",
    });
  }
  if (!parsed.hostname.includes(".")) {
    throw new ScanError(`"${parsed.hostname}" is not a full domain name.`, {
      url: input,
      recommendation: "Include the domain ending, like https://example.com.",
    });
  }

  parsed.hash = "";
  return parsed.toString();
}

export async function runScan(inputUrl: string): Promise<ScanResult> {
  const startedAt = Date.now();
  const requestedUrl = normalizeUrl(inputUrl);

  const crawled = await crawl(requestedUrl);
  if ("error" in crawled) {
    throw new ScanError(`We could not read ${requestedUrl}. ${crawled.error}`, {
      url: requestedUrl,
      status: crawled.outcome.status,
      recommendation:
        "Check the address in a browser. If it loads for you but not for us, something is blocking non-browser traffic — and that is blocking the search and AI crawlers too.",
    });
  }

  const { pages, outcomes, htmlLinkedSitemaps, origin } = crawled;
  const limitations: string[] = [];

  const pageSummaries: PageSummary[] = outcomes.map(({ outcome, role }) => ({
    url: outcome.finalUrl,
    role,
    status: outcome.status,
    elapsedMs: outcome.elapsedMs,
    error: outcome.error ?? undefined,
    blockSignal: outcome.blockSignal ?? undefined,
  }));

  const scannedPaths = pageSummaries.map((page) => page.url);
  const robots = await checkRobots(origin, scannedPaths);
  const sitemap = await checkSitemap(origin, robots.sitemapUrls, htmlLinkedSitemaps);

  const facts = extractBusinessFacts(pages);
  const readable = scoreReadable(pages, facts);
  const discoverable = scoreDiscoverable(robots, sitemap, pageSummaries);
  const callable = scoreCallable(pages, facts);

  if (pages.length === 1) {
    limitations.push(
      "We only read the homepage — no services, contact, or booking page was linked from it in a way we could follow.",
    );
  }
  if (outcomes.some(({ outcome }) => outcome.truncated)) {
    limitations.push(
      `One or more pages were larger than ${Math.round(config.maxBodyBytes / 1_000_000)}MB and were read only in part.`,
    );
  }
  if (pages.some((page) => page.jsDependency.requiresJs)) {
    limitations.push(
      "Some pages build their content with JavaScript. We report the HTML the server actually sends, because that is what most crawlers get — we do not run a browser to fill in the gap.",
    );
  }
  limitations.push(
    `Crawler access is read from the site's robots.txt rules for each named agent. This scan never sends another platform's user agent — every request identified itself as ${config.userAgent}.`,
  );

  return {
    requestedUrl,
    finalUrl: pages[0]!.url,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    userAgent: config.userAgent,
    readable,
    discoverable,
    callable,
    payable: PAYABLE_LINE,
    biggestProblem: biggestProblem(callable, readable, discoverable, pages, facts),
    actions: buildActions(readable, discoverable, callable),
    pagesFetched: pageSummaries,
    limitations,
  };
}
