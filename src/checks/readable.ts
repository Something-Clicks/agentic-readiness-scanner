import type { PageModel } from "../extract/page.ts";
import { normalizePhone } from "../extract/page.ts";
import type { BusinessFacts } from "../extract/business.ts";
import type { CheckResult, PillarResult, Penalty, CheckStatus } from "../types.ts";

/**
 * READABLE — can a parser extract this business's facts without guessing?
 *
 * Weighted sum, 100 points. Structured data is worth more than prose everywhere,
 * because the test the spec sets is extraction without guesswork: a human reading
 * "Open 9-5 most days" understands it; a parser does not.
 */
const WEIGHTS = {
  schema: 30,
  nap: 25,
  services: 20,
  hours: 15,
  pricingAndArea: 10,
} as const;

/** A page that hides its content behind JavaScript is unreadable to most bots. */
const JS_PENALTY = { high: 20, medium: 10, none: 0 } as const;

/** A nearly-empty page costs less: it is a real gap, but not a whole-site failure. */
const THIN_HTML_PENALTY = 8;

export function scoreReadable(pages: PageModel[], facts: BusinessFacts): PillarResult {
  const checks: CheckResult[] = [
    checkSchema(pages, facts),
    checkNap(facts),
    checkServices(facts),
    checkHours(facts),
    checkPricingAndServiceArea(facts),
  ];

  const penalties = jsPenalties(pages);
  const earned = checks.reduce((sum, check) => sum + check.earned, 0);
  const deducted = penalties.reduce((sum, penalty) => sum + penalty.points, 0);

  return {
    name: "READABLE",
    score: clamp(Math.round(earned - deducted)),
    checks,
    penalties,
  };
}

function checkSchema(pages: PageModel[], facts: BusinessFacts): CheckResult {
  const possible = WEIGHTS.schema;
  const invalidBlocks = pages.flatMap((page) => page.structured.invalidJsonLdBlocks);
  const totalBlocks = pages.reduce((sum, page) => sum + page.structured.jsonLdBlockCount, 0);
  const localBusiness = facts.localBusinessNodes;
  const organization = facts.organizationNodes;

  const evidence = {
    localBusinessTypes: localBusiness.flatMap((node) => node.types),
    organizationTypes: organization.flatMap((node) => node.types),
    syntaxes: [...new Set([...localBusiness, ...organization].map((node) => node.syntax))],
    jsonLdBlockCount: totalBlocks,
    invalidJsonLdBlocks: invalidBlocks,
  };

  if (localBusiness.length > 0) {
    // Present. Now check it is actually filled in, not an empty shell.
    const primary = localBusiness[0]!;
    const requiredPresent = ["name", "address", "telephone"].filter((key) => primary.props[key] !== undefined);
    const completeness = requiredPresent.length / 3;
    const earned = Math.round(possible * (0.7 + 0.3 * completeness)) - (invalidBlocks.length > 0 ? 4 : 0);

    const missing = ["name", "address", "telephone"].filter((key) => primary.props[key] === undefined);
    return {
      id: "readable.localbusiness_schema",
      label: "LocalBusiness structured data",
      earned: clamp(earned, possible),
      possible,
      status: statusFor(earned, possible),
      finding:
        missing.length === 0
          ? `The site publishes ${primary.types[0]} structured data with name, address, and phone filled in. A parser can pick up who you are and where you are without reading a word of the page.`
          : `The site publishes ${primary.types[0]} structured data, but ${listPhrase(missing.map(fieldLabel))} ${missing.length === 1 ? "is" : "are"} missing from it.`,
      recommendation:
        missing.length === 0
          ? invalidBlocks.length > 0
            ? `${invalidBlocks.length} other structured-data block${invalidBlocks.length === 1 ? "" : "s"} on the page ${invalidBlocks.length === 1 ? "does" : "do"} not parse. Fix or remove ${invalidBlocks.length === 1 ? "it" : "them"} — a broken block can take valid ones down with it.`
            : undefined
          : `Add ${listPhrase(missing.map(fieldLabel))} to the ${primary.types[0]} block.`,
      evidence,
    };
  }

  if (organization.length > 0) {
    const earned = Math.round(possible * 0.4);
    return {
      id: "readable.localbusiness_schema",
      label: "LocalBusiness structured data",
      earned,
      possible,
      status: "partial",
      finding:
        "The site publishes Organization structured data but not LocalBusiness. Organization says a company exists. It does not say you have a storefront, a service area, or hours, so local results treat you as generic.",
      recommendation:
        "Change the type to LocalBusiness, or the subtype that matches your trade (Plumber, HVACBusiness, Restaurant, and so on), and add address, phone, and hours.",
      evidence,
    };
  }

  if (invalidBlocks.length > 0) {
    return {
      id: "readable.localbusiness_schema",
      label: "LocalBusiness structured data",
      earned: 0,
      possible,
      status: "fail",
      finding: `There ${invalidBlocks.length === 1 ? "is" : "are"} ${invalidBlocks.length} structured-data block${invalidBlocks.length === 1 ? "" : "s"} on the page, and ${invalidBlocks.length === 1 ? "it does" : "none of them"} not parse. Broken JSON is skipped entirely, so it counts as nothing.`,
      recommendation: "Fix the JSON syntax, then add a LocalBusiness block with your name, address, phone, and hours.",
      evidence,
    };
  }

  return {
    id: "readable.localbusiness_schema",
    label: "LocalBusiness structured data",
    earned: 0,
    possible,
    status: "fail",
    finding:
      "There is no LocalBusiness structured data on the site. Anything reading this page has to guess your business name, address, and phone number from the layout, and guesses get dropped.",
    recommendation:
      "Add a LocalBusiness JSON-LD block (or the subtype for your trade) with name, address, telephone, and openingHoursSpecification.",
    evidence,
  };
}

function checkNap(facts: BusinessFacts): CheckResult {
  const possible = WEIGHTS.nap;
  const parts: Array<{ label: string; provenance: string; present: boolean; structured: boolean }> = [
    { label: "name", provenance: facts.name.provenance, present: Boolean(facts.name.value), structured: facts.name.provenance === "structured" },
    { label: "address", provenance: facts.address.provenance, present: Boolean(facts.address.value), structured: facts.address.provenance === "structured" },
    { label: "phone number", provenance: facts.phone.provenance, present: Boolean(facts.phone.value), structured: facts.phone.provenance === "structured" },
  ];

  // Each of the three is worth a third: full credit structured, 40% in prose only.
  const perPart = possible / 3;
  let earned = 0;
  for (const part of parts) {
    if (!part.present) continue;
    earned += part.structured ? perPart : perPart * 0.4;
  }

  const conflictingPhones = facts.allPhones.length > 1;
  if (conflictingPhones) earned -= perPart * 0.3;

  const missing = parts.filter((part) => !part.present).map((part) => part.label);
  const proseOnly = parts.filter((part) => part.present && !part.structured).map((part) => part.label);

  let finding: string;
  let recommendation: string | undefined;

  if (missing.length > 0) {
    finding = `We could not find ${listPhrase(missing)} anywhere on the pages we read.`;
    recommendation = `Put ${listPhrase(missing)} in the page text and in the LocalBusiness structured data.`;
  } else if (proseOnly.length > 0) {
    finding = `Your ${listPhrase(proseOnly)} ${proseOnly.length === 1 ? "appears" : "appear"} on the page as text but ${proseOnly.length === 1 ? "is" : "are"} not in structured data. A parser has to guess which line is which.`;
    recommendation = `Add ${listPhrase(proseOnly)} to the LocalBusiness block so it is stated, not inferred.`;
  } else {
    finding = "Business name, address, and phone number are all present in structured data.";
  }

  if (conflictingPhones) {
    const shown = facts.allPhones.map(formatPhone).join(" and ");
    finding += ` We also found ${facts.allPhones.length} different phone numbers across the site (${shown}). When the numbers disagree, listings pick one, and it may not be the one that rings.`;
    recommendation = `${recommendation ? `${recommendation} ` : ""}Use one number everywhere, or mark the others with a role so it is clear which is the main line.`;
  }

  return {
    id: "readable.nap",
    label: "Name, address, phone",
    earned: clamp(Math.round(earned), possible),
    possible,
    status: statusFor(earned, possible),
    finding,
    recommendation,
    evidence: {
      name: facts.name,
      address: facts.address,
      phone: facts.phone,
      distinctPhoneNumbers: facts.allPhones.map(formatPhone),
      nameCandidates: facts.nameCandidates,
    },
  };
}

function checkServices(facts: BusinessFacts): CheckResult {
  const possible = WEIGHTS.services;
  const { provenance, value, source } = facts.services;

  if (provenance === "structured") {
    return {
      id: "readable.services_structured",
      label: "Services as structured data",
      earned: possible,
      possible,
      status: "pass",
      finding: `${value.length} service${value.length === 1 ? "" : "s"} ${value.length === 1 ? "is" : "are"} published as structured data: ${previewList(value)}.`,
      evidence: { services: value, source },
    };
  }

  if (provenance === "prose") {
    const earned = Math.round(possible * 0.35);
    return {
      id: "readable.services_structured",
      label: "Services as structured data",
      earned,
      possible,
      status: "partial",
      finding: `Your services are written out on the page (${previewList(value)}) but they are not marked up as services. Anything reading the page has to infer which headings are services and which are marketing copy.`,
      recommendation:
        "Add Service or OfferCatalog structured data listing each service by name, so the list is stated rather than inferred from layout.",
      evidence: { services: value, source },
    };
  }

  return {
    id: "readable.services_structured",
    label: "Services as structured data",
    earned: 0,
    possible,
    status: "fail",
    finding:
      "We could not extract a list of what you actually do. Nothing on the pages we read presents your services in a form a parser can pull out.",
    recommendation: "Add a services page that lists each service by name, and mark each one up as a Service.",
    evidence: { services: value, source },
  };
}

function checkHours(facts: BusinessFacts): CheckResult {
  const possible = WEIGHTS.hours;
  const { provenance, value, source } = facts.hours;

  if (provenance === "structured") {
    return {
      id: "readable.hours_structured",
      label: "Hours of operation as structured data",
      earned: possible,
      possible,
      status: "pass",
      finding: `Opening hours are published as structured data (${value.length} entr${value.length === 1 ? "y" : "ies"}).`,
      evidence: { hours: value, source },
    };
  }

  if (provenance === "prose") {
    const earned = Math.round(possible * 0.35);
    return {
      id: "readable.hours_structured",
      label: "Hours of operation as structured data",
      earned,
      possible,
      status: "partial",
      finding:
        "Your hours are written on the page but not marked up. \"Mon-Fri 8-5\" in a footer is readable to a person and ambiguous to a parser — 8am or 8pm, and which timezone.",
      recommendation:
        "Add openingHoursSpecification to the LocalBusiness block with 24-hour opens/closes times for each day.",
      evidence: { hours: value, source },
    };
  }

  return {
    id: "readable.hours_structured",
    label: "Hours of operation as structured data",
    earned: 0,
    possible,
    status: "fail",
    finding:
      "We could not find your hours anywhere. Someone asking an assistant \"are they open right now\" gets no answer, and the assistant moves on to a business that published theirs.",
    recommendation: "Publish your hours on the site and add openingHoursSpecification to the LocalBusiness block.",
    evidence: { hours: value, source },
  };
}

function checkPricingAndServiceArea(facts: BusinessFacts): CheckResult {
  const possible = WEIGHTS.pricingAndArea;
  const half = possible / 2;

  const pricingEarned =
    facts.pricing.provenance === "structured" ? half : facts.pricing.provenance === "prose" ? half * 0.4 : 0;
  const areaEarned =
    facts.serviceArea.provenance === "structured" ? half : facts.serviceArea.provenance === "prose" ? half * 0.4 : 0;
  const earned = pricingEarned + areaEarned;

  const gaps: string[] = [];
  if (facts.pricing.provenance === "absent") gaps.push("no pricing information of any kind");
  else if (facts.pricing.provenance === "prose") gaps.push("pricing only as text");
  if (facts.serviceArea.provenance === "absent") gaps.push("no service area");
  else if (facts.serviceArea.provenance === "prose") gaps.push("service area only as text");

  return {
    id: "readable.pricing_service_area",
    label: "Pricing and service area in a parseable form",
    earned: clamp(Math.round(earned), possible),
    possible,
    status: statusFor(earned, possible),
    finding:
      gaps.length === 0
        ? "Pricing and service area are both published in a form a parser can read."
        : `We found ${listPhrase(gaps)}. These are the two questions a customer asks before calling — "do you come out here" and "roughly what does it cost" — and right now neither can be answered without a phone call.`,
    recommendation:
      gaps.length === 0
        ? undefined
        : "Publish a price range or starting prices, and list the cities or ZIP codes you cover. Mark both up with priceRange and areaServed.",
    evidence: { pricing: facts.pricing, serviceArea: facts.serviceArea },
  };
}

/**
 * We do not run a headless browser to work around this — the spec is explicit that
 * a JS-only site is a finding to report, not an obstacle to route around. Reporting
 * it is the honest answer: most bots reading this site see what we saw.
 */
function jsPenalties(pages: PageModel[]): Penalty[] {
  const javascript = pages.filter((page) => page.jsDependency.kind === "javascript");
  const thin = pages.filter((page) => page.jsDependency.kind === "thin-html");
  const penalties: Penalty[] = [];

  if (javascript.length > 0) {
    const worst = javascript.reduce((a, b) =>
      JS_PENALTY[b.jsDependency.confidence] > JS_PENALTY[a.jsDependency.confidence] ? b : a,
    );
    penalties.push({
      id: "readable.requires_javascript",
      label: "Content requires JavaScript",
      points: JS_PENALTY[worst.jsDependency.confidence],
      finding:
        `${javascript.length} ${javascript.length === 1 ? "page" : "pages"} we fetched came back nearly empty — the content is assembled by JavaScript in the browser. ` +
        `We report what the server actually sent, because that is what most crawlers get. ${worst.jsDependency.reasons.join(" ")}`,
      recommendation:
        "Serve the real content in the HTML — server-side rendering, static pre-rendering, or at minimum the business facts, services, and contact details in the initial response.",
    });
  }

  if (thin.length > 0) {
    penalties.push({
      id: "readable.thin_html",
      label: "Page served with almost nothing in it",
      points: THIN_HTML_PENALTY,
      finding:
        `${thin.length} ${thin.length === 1 ? "page" : "pages"} we fetched arrived nearly empty: ${thin.map((page) => page.url).join(", ")}. ` +
        `We found no sign of JavaScript rendering, so this looks like the whole page. ${thin[0]!.jsDependency.reasons.join(" ")} ` +
        `Anything that only exists inside an embed or an iframe is not part of what a crawler reads.`,
      recommendation:
        "Put the page's real content in its own HTML — a heading, the details, and a text link out to any embedded tool.",
    });
  }

  return penalties.filter((penalty) => penalty.points > 0);
}

function statusFor(earned: number, possible: number): CheckStatus {
  const ratio = possible === 0 ? 0 : earned / possible;
  if (ratio >= 0.9) return "pass";
  if (ratio > 0) return "partial";
  return "fail";
}

function clamp(value: number, max = 100): number {
  return Math.max(0, Math.min(max, value));
}

function fieldLabel(key: string): string {
  return { name: "the business name", address: "the address", telephone: "the phone number" }[key] ?? key;
}

export function listPhrase(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function previewList(items: string[], max = 4): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown}, and ${items.length - max} more` : shown;
}

function formatPhone(digits: string): string {
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}
