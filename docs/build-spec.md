# Scan — Implementation Spec

**Naming note:** the public product names are **Scan**, **Fix**, and **Monitor**. "Readable," "Discoverable," "Callable," and "Payable" stay unchanged — those are the diagnostic concepts Scan reports on, not tier names.

This is the build spec for the full product described in Section 7 of the business plan: a system that determines whether a local business's website is Readable, Discoverable, and Callable by AI agents — and, in later phases, fixes what's broken and monitors it continuously.

---

## Phase 1 — Diagnostic

**Purpose:** powers the free and $29 Scan tiers.

### Input / Output

**Input:** a business URL.

**Output:**
```
SOMETHING CLICKS — AGENTIC READINESS

READABLE       82/100
DISCOVERABLE   91/100
CALLABLE       34/100
PAYABLE        — roadmap

BIGGEST PROBLEM
Your website has a booking form, but an agent cannot
reliably determine availability or complete the booking.

ACTIONS
1. Expose booking capability
2. Make service-area data machine-readable
3. Connect structured service information
```

Free tier shows the four scores and the biggest problem. The $29 tier unlocks the full itemized gap report behind each score.

### Scoring logic

**READABLE (0–100)**
Fetch the raw HTML with an honest, disclosed user agent (never spoof another platform's crawler identity). Check for:
- `LocalBusiness` (or subtype) JSON-LD / microdata / RDFa present and valid
- Business name, address, phone (NAP) present and consistent across the page
- Services listed as structured data, not only in prose
- Hours of operation present as structured data (`openingHoursSpecification` or equivalent)
- Pricing/service-area info present in any parseable form

Score as a weighted sum. Missing structured data costs more than missing prose — the test is "can a parser extract this without guessing."

**DISCOVERABLE (0–100)**
- Parse `robots.txt` for explicit disallow rules against Googlebot, OAI-SearchBot, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot
- Check for a sitemap (referenced in `robots.txt`, at `/sitemap.xml`, or otherwise discoverable)
- Fetch the homepage and 2–3 key pages (services/contact/booking) using the honest, disclosed user agent defined for this product — never a spoofed bot identity, per the product integrity constraints below. Derive per-bot access from `robots.txt` rules plus block signals observed on this honest fetch (403s, CAPTCHA redirects, WAF challenge pages), and state in the report that access is inferred this way rather than tested per bot.
- Flag response times slow enough that a bot with a limited fetch budget would likely abandon the page

Report each check individually (not just a rolled-up number) so the gap report can cite specifics.

**CALLABLE (0–100) — task-path trace**
Walk this path and score where it breaks:
1. **Understand services** — can a specific service list be extracted from Readable data?
2. **Determine service area** — is there a parseable service area (city/region list, radius, ZIP list)? Prose like "serving the greater metro area" doesn't count.
3. **Determine hours/availability** — structured hours present? Any live/real-time availability signal (partial credit even for a simple "open now" indicator)?
4. **Request a quote** — can a machine complete this? A plain `<form>` with no labeled fields or API is "human form only" (partial credit at best); a form with labeled fields and no CAPTCHA scores higher.
5. **Book/contact** — any machine-accessible booking path (API, structured `tel:`/`mailto:` action, parseable third-party booking widget) vs. a dead end (phone-only, image-embedded number, JS-only render with no fallback)?

Score each step 0–20, sum to 100. The "Biggest Problem" line is generated from the lowest-scoring step, phrased in plain language.

**PAYABLE**
Report the literal string `— roadmap`. Not scored, not built in Phase 1–3. This is the one deliberate placeholder — everything else in the scanner is full-strength.

### Technical notes
- Parse HTML with a standard parser to extract JSON-LD, meta tags, and visible text.
- If a site requires JS rendering to expose real content, that's itself a Readable/Discoverable finding to report ("this page isn't readable without executing JavaScript, which many bots don't do") — don't quietly work around it with a headless browser, since that would hide a real finding.
- Design the scan to run synchronously per request initially; move to a queue once volume requires it.

---

## Phase 2 — Patching

**Purpose:** powers the Fix tier.

**Critical constraint: Fix is a fixed-scope, standardized product — not unlimited website development.** The Fix tier covers a defined set of automatable and repeatable implementations. It must not be able to turn into open-ended manual development work when a customer's site is severely broken, highly custom, or built on a platform that resists the required changes. Every item Scan finds gets classified into what Fix can and can't do before any work happens — the system should never silently attempt work outside the standard scope.

### Standard Fix scope

1. **Structured data**
   - Generate and implement appropriate LocalBusiness (or relevant subtype) JSON-LD.
   - Generate Service structured data where the platform supports it.
   - Validate the resulting structured data.

2. **Machine-readable business information**
   - Business name, address, phone, services, hours, service area, and pricing where available — pulled from the Phase 1 crawl plus any info the owner confirms/corrects during onboarding.

3. **`/llms.txt`**
   - Generate it from the verified business information.
   - Validate it.
   - Deploy automatically where technically supported, or provide clear deployment instructions where it isn't.

4. **Callable-path improvements**
   - Standard machine-readable service information and service-area data.
   - Clearly labeled quote/contact form fields.
   - Structured `tel:` / `mailto:` / booking-or-contact actions.
   - Other standard fixes implementable without custom application development.

5. **Re-validation**
   - Automatically re-run the Phase 1 Scan after Fix runs.
   - Present the before/after result as the primary deliverable — this is the proof of value and should be a first-class, polished output, not a debug log.
   - Explicitly list what was successfully fixed and what remains unresolved.

### Platform boundaries

Design Fix around repeatable implementations for common platforms where technically possible: WordPress, Webflow, Squarespace, Wix, and standard/static sites. Do not assume every site can be automatically modified — platform support should be detected, not assumed, and the fixability classification below should reflect what's actually achievable on the specific platform found.

### What's out of standard scope

If Scan identifies something that falls outside the standardized Fix scope, the system must say so clearly rather than attempting it. Examples: a custom booking application requiring new backend/API development, broken hosting or DNS, a severely broken site, a custom JavaScript application requiring substantial development, a booking provider with no accessible machine-readable integration, a platform that doesn't permit the required modification, a needed major redesign, or anything requiring extensive manual developer intervention.

The report should be able to say, plainly:

> "Fix can address the standard machine-readability issues identified on this site. The following items require custom development and are outside the standard Fix scope."

### Fixability classification

Every item Scan finds gets tagged with one of the following before Fix runs, and the tag is shown to the customer:

- **Automatically fixable** — Fix deploys this without manual intervention.
- **Fixable with standard implementation** — achievable within standard scope, may need a manual step on a specific platform.
- **Requires customer/platform access** — blocked on credentials, DNS access, or a platform-side action only the owner can take.
- **Requires custom development** — outside standard scope; needs custom engineering work, not included in the Fix tier.
- **Not fixable through the current Fix system** — no path to resolve it with this product today.

### On cost/margin assumptions

Do not build in assumptions about margin percentage, minutes of labor per Fix, COGS, or compute cost — those aren't established facts, and Fix's actual scope and economics should be measured after real customers use it, not assumed up front. The engineering requirement is a standardized, repeatable scope with honest classification — not a specific margin target.

---

## Phase 3 — Monitoring

**Purpose:** powers the $49/month Monitor tier.

### Components

1. **Scheduled re-scans** — re-run the Phase 1 scan on a regular cadence (e.g., weekly) to catch drift when the business updates hours, pricing, or services independently.
2. **Crawler-hit logging** — capture and log actual requests from named bots (Googlebot, OAI-SearchBot, ClaudeBot/Claude-SearchBot, PerplexityBot, etc.) against the business's site/endpoints.
3. **Monthly report** — a plain-language summary for a non-technical owner, e.g., "ClaudeBot and OAI-SearchBot checked your booking page 28 times this month," plus any score changes since the last report.
4. **Drift alerting** — flag when a previously-passing check starts failing (CMS update wipes structured data, new WAF rule blocks a crawler, hours page goes stale).

---

## Phase 4 — Payable (roadmap only)

Not scoped for build. Revisit once agent-payment standards (e.g., x402) are mature and customers are actually asking for it. Keep the `— roadmap` label in every report until then.

---

## Product integrity constraints (apply across every phase)

- Always fetch with an honest, disclosed user agent — never impersonate Googlebot or another platform's crawler.
- Never claim the product can negotiate with, talk directly to, or guarantee action from a specific AI agent.
- Score and report only what's actually verifiable; the Payable roadmap label exists specifically so the product never implies a capability it doesn't have.

---

## Rollout sequencing

Build and ship Phase 1 first and validate scoring accuracy against 15–20 real businesses before starting Phase 2. Build and ship Phase 2 and get a first cohort of real before/after case studies before starting Phase 3. This isn't about limiting ambition — it's that Phase 2's patching logic depends on Phase 1's scoring being trustworthy, and Phase 3's monitoring depends on Phase 2 producing real fixes worth tracking.
