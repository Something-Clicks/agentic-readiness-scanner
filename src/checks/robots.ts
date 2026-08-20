import robotsParserImport from "robots-parser";

/**
 * robots-parser ships a .d.ts whose ambient module declaration hides its own call
 * signature, so TypeScript sees a namespace rather than a function. The runtime
 * export is the function; this restates that shape rather than loosening the build.
 */
interface ParsedRobots {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
  getPreferredHost(): string | null;
}
const robotsParser = robotsParserImport as unknown as (url: string, contents: string) => ParsedRobots;
import { Readable } from "node:stream";
import { parseSitemap } from "sitemap";
import * as cheerio from "cheerio";
import { fetchPage } from "../fetcher.ts";

/**
 * The named agents the spec asks us to report on. We check what robots.txt says
 * about each one — we do not send their user agent strings. Impersonating a
 * crawler to see what it sees would make every finding in this report unreliable,
 * and it is the exact behaviour this product exists to measure.
 */
export const NAMED_AGENTS = [
  { name: "Googlebot", operator: "Google Search and AI Overviews" },
  { name: "OAI-SearchBot", operator: "ChatGPT search" },
  { name: "ClaudeBot", operator: "Anthropic" },
  { name: "Claude-SearchBot", operator: "Claude search" },
  { name: "Claude-User", operator: "Claude browsing on a person's behalf" },
  { name: "PerplexityBot", operator: "Perplexity" },
] as const;

export interface AgentAccess {
  agent: string;
  operator: string;
  /** True when robots.txt permits this agent to fetch the homepage. */
  homepageAllowed: boolean;
  /** Paths among the pages we scanned that robots.txt disallows for this agent. */
  disallowedPaths: string[];
  /** Crawl-delay declared for this agent, in seconds. */
  crawlDelay: number | null;
}

export interface RobotsReport {
  url: string;
  status: number | null;
  exists: boolean;
  fetchError: string | null;
  /** Raw robots.txt body, capped for reporting. */
  body: string;
  sitemapUrls: string[];
  agentAccess: AgentAccess[];
  /** True when robots.txt disallows everything for every agent. */
  blocksEverything: boolean;
  /** Set when robots.txt returned HTML instead of plain text — usually a soft 404. */
  contentTypeWarning: string | null;
}

export async function checkRobots(origin: string, scannedPaths: string[]): Promise<RobotsReport> {
  const robotsUrl = new URL("/robots.txt", origin).toString();
  const outcome = await fetchPage(robotsUrl);

  const report: RobotsReport = {
    url: robotsUrl,
    status: outcome.status,
    exists: false,
    fetchError: outcome.error,
    body: "",
    sitemapUrls: [],
    agentAccess: [],
    blocksEverything: false,
    contentTypeWarning: null,
  };

  const looksLikeHtml = /<html|<!doctype html/i.test(outcome.body.slice(0, 500));
  report.exists = outcome.status === 200 && outcome.body.trim().length > 0 && !looksLikeHtml;

  if (outcome.status === 200 && looksLikeHtml) {
    report.contentTypeWarning =
      "The server returned an HTML page at /robots.txt instead of a plain text file. Crawlers read that as no robots.txt at all.";
  }

  if (!report.exists) {
    // No robots.txt means nothing is disallowed. That is a valid, permissive state.
    report.agentAccess = NAMED_AGENTS.map(({ name, operator }) => ({
      agent: name,
      operator,
      homepageAllowed: true,
      disallowedPaths: [],
      crawlDelay: null,
    }));
    return report;
  }

  report.body = outcome.body.slice(0, 20_000);
  const robots = robotsParser(robotsUrl, outcome.body);
  report.sitemapUrls = robots.getSitemaps();

  report.agentAccess = NAMED_AGENTS.map(({ name, operator }) => {
    const homepageAllowed = robots.isAllowed(origin, name) !== false;
    const disallowedPaths = scannedPaths.filter((path) => robots.isAllowed(path, name) === false);
    const crawlDelay = robots.getCrawlDelay(name) ?? null;
    return { agent: name, operator, homepageAllowed, disallowedPaths, crawlDelay };
  });

  report.blocksEverything = report.agentAccess.every((access) => !access.homepageAllowed);
  return report;
}

export interface SitemapReport {
  found: boolean;
  /** Where we found it: referenced in robots.txt, or at a conventional location. */
  discoveredVia: "robots.txt" | "conventional-path" | "html-link" | null;
  url: string | null;
  status: number | null;
  /** True when the XML parsed cleanly. */
  parsed: boolean;
  urlCount: number;
  isIndex: boolean;
  childSitemapCount: number;
  error: string | null;
  /** Locations we tried and what came back, so the full report can show the attempts. */
  attempts: Array<{ url: string; status: number | null; result: string }>;
}

const CONVENTIONAL_SITEMAP_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemap1.xml",
  "/wp-sitemap.xml",
  "/sitemap.xml.gz",
];

export async function checkSitemap(
  origin: string,
  robotsSitemapUrls: string[],
  htmlLinkedSitemaps: string[],
): Promise<SitemapReport> {
  const report: SitemapReport = {
    found: false,
    discoveredVia: null,
    url: null,
    status: null,
    parsed: false,
    urlCount: 0,
    isIndex: false,
    childSitemapCount: 0,
    error: null,
    attempts: [],
  };

  const candidates: Array<{ url: string; via: NonNullable<SitemapReport["discoveredVia"]> }> = [
    ...robotsSitemapUrls.map((url) => ({ url, via: "robots.txt" as const })),
    ...htmlLinkedSitemaps.map((url) => ({ url, via: "html-link" as const })),
    ...CONVENTIONAL_SITEMAP_PATHS.map((path) => ({
      url: new URL(path, origin).toString(),
      via: "conventional-path" as const,
    })),
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    // Gzipped sitemaps need decompression we do not do here; note and skip.
    if (candidate.url.endsWith(".gz")) {
      report.attempts.push({ url: candidate.url, status: null, result: "skipped — gzipped sitemap not read" });
      continue;
    }

    const outcome = await fetchPage(candidate.url);
    if (outcome.error) {
      report.attempts.push({ url: candidate.url, status: null, result: outcome.error });
      continue;
    }
    if (outcome.status !== 200) {
      report.attempts.push({ url: candidate.url, status: outcome.status, result: `HTTP ${outcome.status}` });
      continue;
    }
    if (!/<(?:urlset|sitemapindex)/i.test(outcome.body)) {
      report.attempts.push({
        url: candidate.url,
        status: outcome.status,
        result: "responded 200 but the body is not sitemap XML",
      });
      continue;
    }

    report.found = true;
    report.discoveredVia = candidate.via;
    report.url = outcome.finalUrl;
    report.status = outcome.status;
    report.attempts.push({ url: candidate.url, status: outcome.status, result: "sitemap XML found" });

    const isIndex = /<sitemapindex/i.test(outcome.body);
    report.isIndex = isIndex;

    if (isIndex) {
      const $ = cheerio.load(outcome.body, { xmlMode: true });
      report.childSitemapCount = $("sitemap > loc").length;
      report.parsed = report.childSitemapCount > 0;
      if (!report.parsed) report.error = "The sitemap index parsed but lists no child sitemaps.";
      return report;
    }

    try {
      const items = await parseSitemap(Readable.from([outcome.body]));
      report.urlCount = items.length;
      report.parsed = true;
      if (items.length === 0) report.error = "The sitemap parsed but lists no URLs.";
    } catch (error) {
      // Fall back to counting <loc> elements — a sitemap the strict parser rejects
      // is still a finding worth reporting precisely.
      const $ = cheerio.load(outcome.body, { xmlMode: true });
      report.urlCount = $("url > loc").length;
      report.parsed = false;
      report.error = `The sitemap XML did not parse cleanly: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    return report;
  }

  return report;
}
