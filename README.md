# agentic-readiness-scanner

Scan, Fix, and Monitor local business websites for AI agent readability, discoverability, and callable actions.

Something Clicks helps local businesses become understandable, discoverable, and transactable by the machines now deciding which local businesses get found — search crawlers, AI systems (Google AI Overviews, ChatGPT, Claude, Perplexity), and the autonomous agents starting to browse, book, and buy on a person's behalf.

## Products

- **Scan** — diagnoses whether AI agents can find, understand, and act on a business website. Scores Readable / Discoverable / Callable; reports Payable as roadmap.
- **Fix** — implements the corrections Scan identifies, within a fixed, standardized scope. See `docs/build-spec.md` for the exact scope boundaries and fixability classification.
- **Monitor** — continuously checks for changes that affect machine readability, discoverability, or actionability.

## Status

Phase 1 (Scan / Diagnostic) is built and runnable. Phase 2 (Fix), Phase 3 (Monitor),
and Phase 4 (Payable) are not started. Per the rollout sequencing in the build spec,
Phase 1's scoring should be validated against 15–20 real businesses before Phase 2
begins.

## Docs

- [`docs/build-spec.md`](docs/build-spec.md) — full technical implementation spec, phase by phase. This is the source of truth for what to build — read it before writing code.

## Getting started

Phase 1 (Scan) is built. Node 20 or newer.

```bash
npm install
cp .env.example .env
```

### Run a scan from the command line

```bash
npm run scan -- https://example.com          # free tier: four scores and the biggest problem
npm run scan -- https://example.com --full   # $29 tier: every check, itemized
npm run scan -- https://example.com --full --json
```

### Run it as an API

```bash
npm run dev     # watches for changes
npm start       # after npm run build
```

```bash
curl "http://localhost:3000/scan?url=example.com&format=text"
curl "http://localhost:3000/scan?url=example.com&tier=full"
curl -X POST http://localhost:3000/scan \
  -H 'content-type: application/json' \
  -d '{"url":"example.com","tier":"full"}'
```

| | |
|---|---|
| `GET /scan?url=…` | Runs a scan. `tier=free` (default) or `tier=full`. `format=json` (default) or `format=text`. |
| `POST /scan` | Same, with `{"url": …, "tier": …, "format": …}` as the JSON body. |
| `GET /health` | Liveness, plus the user agent this instance fetches with. |

A scan runs synchronously and returns in the same request. There is no queue and no
background worker — one request, one scan, one response. Expect a few seconds per
scan, since it fetches the homepage, up to three key pages, `robots.txt`, and the
sitemap, one at a time so it does not hammer a small business's server.

### What comes back

The free tier returns the four scores and the biggest problem, exactly as laid out
in `docs/build-spec.md`:

```
SOMETHING CLICKS — AGENTIC READINESS

READABLE       92/100
DISCOVERABLE   100/100
CALLABLE       78/100
PAYABLE        — roadmap

BIGGEST PROBLEM
Your website has a booking form, but an agent cannot
reliably determine availability or complete the booking.

ACTIONS
1. Expose booking capability
2. Make service-area data machine-readable
3. Connect structured service information
```

The `full` tier returns the same scan with the itemized gap report behind each
score: every check with its points, what we found, and what to do about it, plus
the pages we read, their status codes and timings, and what the scan could not
cover. Same scan either way — the free tier shows less of it, it does not run less
of it.

### How the three scores are built

- **Readable** (100 pts) — LocalBusiness structured data (30), name/address/phone (25),
  services as structured data (20), hours as structured data (15), pricing and
  service area (10). Deductions on top for pages whose content is not in the HTML.
  Structured data is worth more than prose everywhere, because the test is whether
  a parser can extract a fact without guessing.
- **Discoverable** (100 pts) — crawler access in `robots.txt` (35), sitemap (25),
  pages served without a block (25), response time (15).
- **Callable** (100 pts) — the five-step task path an agent walks to hire the
  business, 20 points each: understand services → determine service area →
  determine hours and availability → request a quote → book or contact. The
  "Biggest problem" line comes from where the path breaks.
- **Payable** — never scored. Always the literal string `— roadmap`.

### Tests

```bash
npm test        # scores a fixture site at both ends of the range
npm run typecheck
```

### A note on how crawler access is measured

`build-spec.md`'s Discoverable section suggests fetching pages "with each relevant
bot user agent." This implementation does not do that, and will not: sending
Googlebot's or ClaudeBot's user agent string is impersonating another platform's
crawler, which the product integrity constraints below forbid and which would make
every finding in the report untrustworthy. Instead, per-agent access is read from
the site's own `robots.txt` rules for each named agent, and block signals (403s,
CAPTCHA pages, WAF challenge screens) are detected on our own honest fetch. Every
report says so in as many words.

Likewise, there is no headless browser. If a site needs JavaScript to show its
content, that is reported as a finding — because that is what most crawlers
actually experience — rather than papered over by rendering the page ourselves.

## Product integrity constraints (apply everywhere in this codebase)

- Always fetch with an honest, disclosed user agent. Never impersonate Googlebot or another platform's crawler.
- Never claim the product can negotiate with, talk directly to, or guarantee action from a specific AI agent.
- Score and report only what's actually verifiable. The Payable line is always labeled as roadmap, never scored.
