import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { config } from "./config.ts";
import type { ScanBudget } from "./budget.ts";

// Honour HTTP_PROXY / HTTPS_PROXY / NO_PROXY. Node's global fetch ignores them on
// its own, and plenty of deployments put an egress proxy in front of the scanner.
setGlobalDispatcher(new EnvHttpProxyAgent());

export interface FetchOutcome {
  requestedUrl: string;
  /** URL after redirects. */
  finalUrl: string;
  status: number | null;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  contentType: string;
  elapsedMs: number;
  /** Network-level failure (DNS, TLS, timeout). Null when we got a response. */
  error: string | null;
  /** Set when the response body looks like a block page rather than the real page. */
  blockSignal: string | null;
  truncated: boolean;
}

/**
 * Every outbound request in the scanner goes through here, so there is exactly one
 * place that sets the user agent. See config.ts for why it is never another
 * platform's crawler string.
 */
export async function fetchPage(url: string, budget?: ScanBudget): Promise<FetchOutcome> {
  const started = Date.now();
  const timeoutMs = budget ? budget.timeoutForFetch() : config.fetchTimeoutMs;
  const base: FetchOutcome = {
    requestedUrl: url,
    finalUrl: url,
    status: null,
    ok: false,
    headers: {},
    body: "",
    contentType: "",
    elapsedMs: 0,
    error: null,
    blockSignal: null,
    truncated: false,
  };

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": config.userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const { body, truncated } = await readBody(response);
    const elapsedMs = Date.now() - started;
    const contentType = headers["content-type"] ?? "";

    const outcome: FetchOutcome = {
      ...base,
      finalUrl: response.url || url,
      status: response.status,
      ok: response.ok,
      headers,
      body,
      contentType,
      elapsedMs,
      truncated,
    };
    outcome.blockSignal = detectBlock(outcome);
    return outcome;
  } catch (error) {
    return {
      ...base,
      elapsedMs: Date.now() - started,
      error: describeFetchError(error, timeoutMs),
    };
  }
}

async function readBody(response: Response): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (total < config.maxBodyBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total >= config.maxBodyBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }

  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { body: buffer.toString("utf8"), truncated };
}

/**
 * Distinguish "the site said no" from "the site is down". Written in the brand's
 * register: say what happened, not what category of exception was thrown.
 */
function describeFetchError(error: unknown, timeoutMs: number): string {
  const outer = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const causeError = (error as { cause?: { code?: unknown; message?: unknown } })?.cause;
  const cause = String(causeError?.code ?? "");
  // Node's fetch reports every transport failure as "fetch failed"; the useful
  // detail is one level down.
  const causeMessage = typeof causeError?.message === "string" ? causeError.message : "";
  const message = outer === "fetch failed" && causeMessage ? causeMessage : outer;

  if (name === "TimeoutError" || message.includes("timed out")) {
    return `No response within ${formatSeconds(timeoutMs)} seconds.`;
  }
  if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") {
    return "That domain does not resolve. Check the address for a typo, or whether DNS is set up.";
  }
  if (cause === "ECONNREFUSED") {
    return "The server refused the connection.";
  }
  if (cause === "ECONNRESET") {
    return "The server closed the connection before sending a response.";
  }
  if (cause.startsWith("ERR_TLS") || cause === "CERT_HAS_EXPIRED" || message.includes("certificate")) {
    return "The HTTPS certificate did not validate. Bots that check certificates will refuse this page.";
  }
  return `The request failed: ${message}`;
}

/** Signals that a response is a wall rather than the page a visitor would see. */
const BLOCK_BODY_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /just a moment\.\.\./i, signal: "Cloudflare interstitial challenge" },
  { pattern: /cf-browser-verification|cf_chl_opt|challenge-platform/i, signal: "Cloudflare browser check" },
  { pattern: /attention required!\s*\|\s*cloudflare/i, signal: "Cloudflare block page" },
  { pattern: /checking your browser before accessing/i, signal: "browser check interstitial" },
  { pattern: /<title>[^<]*access denied[^<]*<\/title>/i, signal: "access denied page" },
  { pattern: /request unsuccessful\.\s*incapsula/i, signal: "Imperva/Incapsula block" },
  { pattern: /(g-recaptcha|hcaptcha\.com\/1\/api\.js|recaptcha\/api\.js)/i, signal: "CAPTCHA challenge" },
  { pattern: /you (?:have been|are) blocked|bot detection/i, signal: "bot-detection block page" },
  { pattern: /ddos protection by/i, signal: "DDoS protection interstitial" },
];

function detectBlock(outcome: FetchOutcome): string | null {
  if (outcome.status === 403) return "HTTP 403 — the server refused the request";
  if (outcome.status === 429) return "HTTP 429 — rate limited";
  if (outcome.status === 503 && /cloudflare|cf-ray/i.test(JSON.stringify(outcome.headers))) {
    return "HTTP 503 from a protection layer";
  }
  if (outcome.status === 401) return "HTTP 401 — the page requires a login";

  // Only inspect bodies small enough to plausibly be an interstitial.
  if (outcome.body.length < 200_000) {
    for (const { pattern, signal } of BLOCK_BODY_PATTERNS) {
      if (pattern.test(outcome.body)) return signal;
    }
  }
  return null;
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return seconds >= 1 ? String(Math.round(seconds)) : seconds.toFixed(1);
}
