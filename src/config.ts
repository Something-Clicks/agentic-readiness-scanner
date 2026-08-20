import "dotenv/config";

/**
 * Runtime configuration. SCAN_USER_AGENT is the one setting with a product
 * constraint attached: every request this service makes is sent with it, and it
 * must stay an honest, disclosed identity. We never send Googlebot's, ClaudeBot's,
 * or any other platform's crawler string — the whole product is about how those
 * crawlers see a site, and faking their identity would make our own findings a lie.
 */

const DEFAULT_USER_AGENT =
  "SomethingClicksBot/1.0 (+https://somethingclicks.com/bot)";

/** User agent strings we refuse to send, however they are configured. */
const FORBIDDEN_UA_SUBSTRINGS = [
  "googlebot",
  "bingbot",
  "oai-searchbot",
  "gptbot",
  "chatgpt-user",
  "claudebot",
  "claude-searchbot",
  "claude-user",
  "anthropic-ai",
  "perplexitybot",
  "applebot",
  "duckduckbot",
  "yandexbot",
  "baiduspider",
  "slurp",
];

function readUserAgent(): string {
  const raw = (process.env.SCAN_USER_AGENT ?? "").trim().replace(/^"|"$/g, "");
  const ua = raw.length > 0 ? raw : DEFAULT_USER_AGENT;
  const lowered = ua.toLowerCase();
  const impersonated = FORBIDDEN_UA_SUBSTRINGS.find((bot) => lowered.includes(bot));
  if (impersonated) {
    throw new Error(
      `SCAN_USER_AGENT contains "${impersonated}", which impersonates another platform's crawler. ` +
        `Set it to an honest identity that names this service and links to a page explaining it, ` +
        `for example: ${DEFAULT_USER_AGENT}`,
    );
  }
  return ua;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: readInt("PORT", 3000),
  userAgent: readUserAgent(),
  /**
   * Per-request timeout for a single page fetch. Also capped by whatever remains of
   * the scan budget, so this is an upper bound rather than a guarantee.
   */
  fetchTimeoutMs: readInt("SCAN_FETCH_TIMEOUT_MS", 5_000),
  /**
   * Ceiling on the whole scan. Phase 1 runs synchronously, so this bounds the HTTP
   * response too — and therefore has to fit inside the host's function timeout.
   *
   * The default targets the most restrictive realistic case: a serverless platform
   * that allows 10 seconds per request. 8 seconds leaves room for cold start and
   * serialisation on top. On a host with a longer ceiling, raise SCAN_TIMEOUT_MS
   * (and SCAN_FETCH_TIMEOUT_MS with it) rather than editing this.
   */
  scanTimeoutMs: readInt("SCAN_TIMEOUT_MS", 8_000),
  /** Largest response body we will read, in bytes. */
  maxBodyBytes: readInt("SCAN_MAX_BODY_BYTES", 3_000_000),
  /** Key pages fetched beyond the homepage. The spec calls for 2–3. */
  maxKeyPages: readInt("SCAN_MAX_KEY_PAGES", 3),
  /**
   * How many sitemap locations we will actually fetch before giving up on the rest.
   * A site can declare any number of Sitemap: lines in robots.txt, and probing all
   * of them sequentially is how a scan turns into a thin, mostly-timed-out report.
   * A handful of real sitemaps is enough signal; the rest are named as skipped.
   */
  maxSitemapCandidates: readInt("SCAN_MAX_SITEMAP_CANDIDATES", 5),
  /**
   * A response slower than this is flagged: a bot working through a limited
   * fetch budget is likely to give up before the page finishes.
   */
  slowResponseMs: readInt("SCAN_SLOW_RESPONSE_MS", 2_500),
  verySlowResponseMs: readInt("SCAN_VERY_SLOW_RESPONSE_MS", 5_000),
} as const;

export const PAYABLE_LINE = "— roadmap" as const;
