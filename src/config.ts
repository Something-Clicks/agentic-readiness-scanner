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
  /** Per-request timeout for a single page fetch. */
  fetchTimeoutMs: readInt("SCAN_FETCH_TIMEOUT_MS", 15_000),
  /** Ceiling on the whole scan. Phase 1 runs synchronously, so this bounds the response. */
  scanTimeoutMs: readInt("SCAN_TIMEOUT_MS", 60_000),
  /** Largest response body we will read, in bytes. */
  maxBodyBytes: readInt("SCAN_MAX_BODY_BYTES", 3_000_000),
  /** Key pages fetched beyond the homepage. The spec calls for 2–3. */
  maxKeyPages: readInt("SCAN_MAX_KEY_PAGES", 3),
  /**
   * A response slower than this is flagged: a bot working through a limited
   * fetch budget is likely to give up before the page finishes.
   */
  slowResponseMs: readInt("SCAN_SLOW_RESPONSE_MS", 2_500),
  verySlowResponseMs: readInt("SCAN_VERY_SLOW_RESPONSE_MS", 5_000),
} as const;

export const PAYABLE_LINE = "— roadmap" as const;
