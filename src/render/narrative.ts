import type { CallableResult, PillarResult, CheckResult } from "../types.ts";
import type { BusinessFacts } from "../extract/business.ts";
import type { PageModel } from "../extract/page.ts";

/**
 * The "Biggest problem" line and the "Actions" list.
 *
 * Both are written in the register the brand doc asks for: what the owner would say,
 * not what the check is called. A business owner says "the phone stopped ringing,"
 * not "structured data coverage regressed."
 */

/**
 * The spec is explicit: the Biggest Problem line comes from the lowest-scoring
 * Callable step. Callable is where lost work actually happens — a business can be
 * perfectly readable and still lose the job at step 5.
 */
export function biggestProblem(
  callable: CallableResult,
  readable: PillarResult,
  discoverable: PillarResult,
  pages: PageModel[],
  facts: BusinessFacts,
): string {
  const step = callable.breaksAt;

  // The task path only names the biggest problem when it actually breaks. A path
  // scoring near-full has no break to report, and saying otherwise would be a lie
  // the owner can check in thirty seconds.
  if (step.earned >= 18) {
    return biggestProblemOutsideTaskPath(readable, discoverable);
  }

  const hasForm = pages.some((page) => page.forms.some((form) => ["quote", "contact", "booking"].includes(form.purpose)));
  const hasBookingWidget = pages.some((page) => page.bookingProviders.length > 0);
  const hasPhone = Boolean(facts.phone.value);

  switch (step.step) {
    case 1:
      return facts.services.provenance === "prose"
        ? "Your services are written for people to read, but an agent cannot tell which parts of the page are the services you sell."
        : "An agent reading your website cannot work out what services you actually sell.";

    case 2:
      return facts.serviceArea.provenance === "prose"
        ? "Your website says roughly where you work, but an agent cannot check whether a specific address is inside your service area."
        : "Nothing on your website says where you work, so an agent sorting local businesses by address has no way to include you.";

    case 3:
      return facts.hours.provenance === "prose"
        ? "Your hours are on the page as text, so an agent cannot answer \"are they open right now\" without guessing."
        : "Your website does not publish hours or availability, so an agent cannot tell a customer whether you can take the job.";

    case 4:
      if (hasForm) {
        return "Your website has a contact form, but an agent cannot reliably fill it in on a customer's behalf.";
      }
      return "There is no way to request a quote in writing on your website. It is a phone call or nothing.";

    case 5:
      if (hasBookingWidget || hasForm) {
        return "Your website has a booking form, but an agent cannot\nreliably determine availability or complete the booking.";
      }
      if (hasPhone) {
        return "The only way to reach you is by phone. An agent acting for a customer can pass the number along, but it cannot book the job.";
      }
      return "An agent that gets all the way to hiring you finds no way to do it — no linked number, no email, no booking path.";

    default:
      return step.finding;
  }
}

/**
 * Used when the task path holds up. Falls back to the largest remaining gap
 * anywhere else, stated in the owner's register rather than the check's name.
 */
function biggestProblemOutsideTaskPath(readable: PillarResult, discoverable: PillarResult): string {
  const candidates: Array<{ id: string; gap: number }> = [
    ...[...readable.checks, ...discoverable.checks]
      .filter((check) => check.possible > 0)
      .map((check) => ({ id: check.id, gap: check.possible - check.earned })),
    ...readable.penalties.map((penalty) => ({ id: penalty.id, gap: penalty.points })),
  ].filter((candidate) => candidate.gap > 0);

  if (candidates.length === 0) {
    return "Nothing on the checks this scan covers is standing between an agent and hiring you.";
  }

  const worst = candidates.reduce((a, b) => (b.gap > a.gap ? b : a));
  return (
    PLAIN_PROBLEM[worst.id] ??
    "The biggest gap left is in how your site is published rather than in what an agent can do with it — the full report lists it."
  );
}

const PLAIN_PROBLEM: Record<string, string> = {
  "readable.localbusiness_schema":
    "Your website tells a person who you are, but never states it in a form a machine can read, so listings have to guess.",
  "readable.nap":
    "Your name, address, and phone number are not stated consistently enough for a listing to trust which one is right.",
  "readable.services_structured":
    "Your services are written for people to read, but an agent cannot tell which parts of the page are the services you sell.",
  "readable.hours_structured":
    "Your hours are not published in a form an agent can read, so it cannot answer \"are they open right now\".",
  "readable.pricing_service_area":
    "Your website does not answer the two questions people ask before calling: do you come out here, and roughly what does it cost.",
  "readable.requires_javascript":
    "Your pages are assembled in the browser, so the version most crawlers receive is nearly blank.",
  "readable.thin_html":
    "Some of your pages arrive almost empty. Whatever is inside an embed or an iframe is not part of what a crawler reads.",
  "discoverable.agent_access":
    "Your robots.txt turns away crawlers that feed AI answers, so you are not in the pool they answer from.",
  "discoverable.sitemap":
    "There is no sitemap, so crawlers only find the pages that happen to be linked from your homepage.",
  "discoverable.reachability":
    "Something on your site is turning crawlers away before they see a page. We asked politely and were refused.",
  "discoverable.response_time":
    "Your pages are slow enough that a crawler working through a budget is likely to give up partway.",
};

interface ActionCandidate {
  /** Short imperative phrase, the format the spec's sample output uses. */
  label: string;
  /** Lower is more urgent. */
  priority: number;
  /** Points left on the table, used to rank within a priority band. */
  gap: number;
}

/** The three actions in the free-tier output. Ranked by what is costing the most. */
export function buildActions(
  readable: PillarResult,
  discoverable: PillarResult,
  callable: CallableResult,
): string[] {
  const candidates: ActionCandidate[] = [];

  const add = (label: string, priority: number, gap: number) => {
    if (gap <= 0) return;
    candidates.push({ label, priority, gap });
  };

  // Callable first: the task path is where a lost customer actually happens.
  for (const step of callable.steps) {
    const gap = step.possible - step.earned;
    const label = CALLABLE_ACTIONS[step.step];
    if (label) add(label, 1 + step.step * 0.01, gap);
  }

  // Readable next: it is what every other score is built on.
  for (const check of readable.checks) {
    const label = READABLE_ACTIONS[check.id];
    if (label) add(label, 2, check.possible - check.earned);
  }
  for (const penalty of readable.penalties) {
    if (penalty.id === "readable.requires_javascript") {
      add("Serve page content without JavaScript", 1.5, penalty.points);
    }
    if (penalty.id === "readable.thin_html") {
      add("Put real content on the near-empty pages", 2.5, penalty.points);
    }
  }

  // Discoverable last unless something is outright blocked — a blocked crawler
  // outranks everything, because nothing else matters if it cannot get in.
  for (const check of discoverable.checks) {
    const label = DISCOVERABLE_ACTIONS[check.id];
    if (!label) continue;
    const gap = check.possible - check.earned;
    // A crawler that is turned away outranks everything else: nothing further down
    // the list matters to a system that never gets through the door.
    const agents = (check.evidence?.agents ?? []) as Array<{ homepageAllowed?: boolean }>;
    const someoneBlocked = agents.some((agent) => agent.homepageAllowed === false);
    const urgent =
      (check.id === "discoverable.agent_access" && someoneBlocked) ||
      (check.id === "discoverable.reachability" && check.status !== "pass");
    add(label, urgent ? 0.5 : 3, gap);
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => a.priority - b.priority || b.gap - a.gap)
    .filter((candidate) => {
      if (seen.has(candidate.label)) return false;
      seen.add(candidate.label);
      return true;
    })
    .slice(0, 3)
    .map((candidate) => candidate.label);
}

const CALLABLE_ACTIONS: Record<number, string> = {
  1: "Connect structured service information",
  2: "Make service-area data machine-readable",
  3: "Publish hours and availability as data",
  4: "Label the quote form fields",
  5: "Expose booking capability",
};

const READABLE_ACTIONS: Record<string, string> = {
  "readable.localbusiness_schema": "Add LocalBusiness structured data",
  "readable.nap": "State name, address, and phone as data",
  "readable.services_structured": "Connect structured service information",
  "readable.hours_structured": "Publish hours and availability as data",
  "readable.pricing_service_area": "Publish pricing and service area",
};

const DISCOVERABLE_ACTIONS: Record<string, string> = {
  "discoverable.agent_access": "Unblock the crawlers in robots.txt",
  "discoverable.sitemap": "Publish a sitemap and link it in robots.txt",
  "discoverable.reachability": "Let well-behaved crawlers past the firewall",
  "discoverable.response_time": "Cut page response time",
};

/** Every check with points left on it, worst first — the body of the $30 gap report. */
export function rankedGaps(pillars: PillarResult[]): CheckResult[] {
  return pillars
    .flatMap((pillar) => pillar.checks)
    .filter((check) => check.possible > 0 && check.earned < check.possible)
    .sort((a, b) => b.possible - b.earned - (a.possible - a.earned));
}
