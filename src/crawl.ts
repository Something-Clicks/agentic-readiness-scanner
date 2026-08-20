import { config } from "./config.ts";
import { fetchPage, type FetchOutcome } from "./fetcher.ts";
import { buildPageModel, type PageModel } from "./extract/page.ts";
import type { PageRole } from "./types.ts";

/**
 * Ranked patterns for the pages that matter to this diagnostic. The spec asks for
 * the homepage plus 2–3 key pages: services, contact, booking.
 */
const ROLE_PATTERNS: Array<{ role: PageRole; weight: number; url: RegExp; text: RegExp }> = [
  {
    role: "booking",
    weight: 30,
    url: /\/(book|booking|schedule|scheduling|appointment|appointments|reserve|reservations|request-service|book-online)\b/i,
    text: /\b(book (?:now|online|an appointment)|schedule (?:service|an appointment|now)|make (?:a|an) (?:reservation|appointment)|request service)\b/i,
  },
  {
    role: "contact",
    weight: 25,
    url: /\/(contact|contact-us|get-in-touch|quote|get-a-quote|free-quote|request-a-quote|estimate|free-estimate)\b/i,
    text: /\b(contact us|get in touch|get a quote|free quote|request a quote|free estimate|get an estimate)\b/i,
  },
  {
    role: "services",
    weight: 20,
    url: /\/(services|our-services|what-we-do|service-areas?|solutions|treatments|menu|pricing|prices|rates)\b/i,
    text: /\b(our services|services|what we do|service area|pricing|our menu)\b/i,
  },
  {
    role: "about",
    weight: 5,
    url: /\/(about|about-us|our-story|who-we-are)\b/i,
    text: /\b(about us|our story|who we are)\b/i,
  },
];

export interface CrawlResult {
  pages: PageModel[];
  outcomes: Array<{ outcome: FetchOutcome; role: PageRole }>;
  /** Sitemap URLs referenced from the homepage HTML. */
  htmlLinkedSitemaps: string[];
  /** Origin of the final homepage URL, after redirects. */
  origin: string;
}

export async function crawl(startUrl: string): Promise<CrawlResult | { error: string; outcome: FetchOutcome }> {
  const homepageOutcome = await fetchPage(startUrl);

  if (homepageOutcome.error) {
    return { error: homepageOutcome.error, outcome: homepageOutcome };
  }
  if (homepageOutcome.status !== null && homepageOutcome.status >= 400 && !homepageOutcome.blockSignal) {
    return {
      error: `The homepage returned HTTP ${homepageOutcome.status}. There is nothing for a crawler to read at this address.`,
      outcome: homepageOutcome,
    };
  }

  const homepage = buildPageModel(homepageOutcome, "homepage");
  const origin = new URL(homepageOutcome.finalUrl).origin;

  const htmlLinkedSitemaps = homepage.$('link[rel="sitemap"]')
    .toArray()
    .map((element) => String(homepage.$(element).attr("href") ?? ""))
    .map((href) => {
      try {
        return new URL(href, homepageOutcome.finalUrl).toString();
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  const targets = pickKeyPages(homepage, origin);
  const pages: PageModel[] = [homepage];
  const outcomes: Array<{ outcome: FetchOutcome; role: PageRole }> = [
    { outcome: homepageOutcome, role: "homepage" },
  ];

  // Sequential on purpose: this is one business's site, and hammering it in
  // parallel is both rude and a good way to trip the WAF we are trying to measure.
  for (const target of targets) {
    const outcome = await fetchPage(target.url);
    outcomes.push({ outcome, role: target.role });
    if (!outcome.error && outcome.status === 200) {
      pages.push(buildPageModel(outcome, target.role));
    }
  }

  return { pages, outcomes, htmlLinkedSitemaps, origin };
}

function pickKeyPages(homepage: PageModel, origin: string): Array<{ url: string; role: PageRole }> {
  const scored = new Map<string, { url: string; role: PageRole; weight: number }>();

  for (const link of homepage.links) {
    const absolute = link.absolute;
    if (!absolute) continue;
    let parsed: URL;
    try {
      parsed = new URL(absolute);
    } catch {
      continue;
    }
    if (parsed.origin !== origin) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|mp4|mp3|doc|docx)$/i.test(parsed.pathname)) continue;

    parsed.hash = "";
    const normalized = parsed.toString();
    if (normalized === homepage.url || parsed.pathname === "/") continue;

    for (const pattern of ROLE_PATTERNS) {
      const urlMatch = pattern.url.test(parsed.pathname);
      const textMatch = pattern.text.test(link.text);
      if (!urlMatch && !textMatch) continue;
      const weight = pattern.weight + (urlMatch ? 10 : 0) + (textMatch ? 5 : 0);
      const existing = scored.get(normalized);
      if (!existing || weight > existing.weight) {
        scored.set(normalized, { url: normalized, role: pattern.role, weight });
      }
      break;
    }
  }

  // One page per role, highest-weight first, capped at the configured budget.
  const byRole = new Map<PageRole, { url: string; role: PageRole; weight: number }>();
  for (const candidate of [...scored.values()].sort((a, b) => b.weight - a.weight)) {
    if (!byRole.has(candidate.role)) byRole.set(candidate.role, candidate);
  }

  return [...byRole.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, config.maxKeyPages)
    .map(({ url, role }) => ({ url, role }));
}
