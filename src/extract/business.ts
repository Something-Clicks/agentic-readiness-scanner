import type { PageModel } from "./page.ts";
import { normalizePhone, collapse } from "./page.ts";
import {
  findLocalBusinessNodes,
  findNodes,
  findOrganizationNodes,
  stripSchemaPrefix,
  textValue,
  toArray,
  type StructuredNode,
} from "./structuredData.ts";

/**
 * The business facts a parser can actually extract, and — crucially — whether each
 * one came from structured data or was only inferred from prose. The whole scoring
 * model turns on that distinction: "can a parser extract this without guessing."
 */
export type Provenance = "structured" | "prose" | "absent";

export interface Extracted<T> {
  value: T;
  provenance: Provenance;
  /** Where we found it — schema type, selector, or a short text excerpt. */
  source: string | null;
}

export interface BusinessFacts {
  name: Extracted<string | null>;
  address: Extracted<PostalAddress | null>;
  phone: Extracted<string | null>;
  services: Extracted<string[]>;
  hours: Extracted<OpeningHours[]>;
  serviceArea: Extracted<string[]>;
  pricing: Extracted<PricingSignal[]>;
  /** Every distinct phone number seen anywhere, for the consistency check. */
  allPhones: string[];
  /** Every distinct business-name candidate seen, for the consistency check. */
  nameCandidates: string[];
  /** schema.org potentialAction entries — the strongest machine-callable signal. */
  potentialActions: ActionSignal[];
  /** A live/real-time availability indicator, e.g. "Open now". */
  availabilitySignal: AvailabilitySignal | null;
  localBusinessNodes: StructuredNode[];
  organizationNodes: StructuredNode[];
}

export interface PostalAddress {
  streetAddress: string | null;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  formatted: string;
}

export interface OpeningHours {
  days: string[];
  opens: string | null;
  closes: string | null;
  raw: string;
}

export interface PricingSignal {
  kind: "offer" | "priceRange" | "priceSpecification" | "prose";
  value: string;
}

export interface ActionSignal {
  type: string;
  target: string | null;
  /** True when the action names an HTTP endpoint a machine could actually call. */
  machineTargetable: boolean;
}

export interface AvailabilitySignal {
  kind: "structured-special-hours" | "open-now-indicator" | "booking-widget-availability";
  detail: string;
}

const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export function extractBusinessFacts(pages: PageModel[]): BusinessFacts {
  const homepage = pages[0]!;
  const allNodes = pages.flatMap((page) => page.structured.nodes);
  const combined = { nodes: allNodes, invalidJsonLdBlocks: [], jsonLdBlockCount: 0 };
  const localBusinessNodes = findLocalBusinessNodes(combined);
  const organizationNodes = findOrganizationNodes(combined);
  const primary = localBusinessNodes[0] ?? organizationNodes[0] ?? null;

  return {
    name: extractName(primary, pages),
    address: extractAddress(primary, pages),
    phone: extractPhone(primary, pages),
    services: extractServices(combined, primary, pages),
    hours: extractHours(primary, pages),
    serviceArea: extractServiceArea(primary, pages),
    pricing: extractPricing(combined, primary, pages),
    allPhones: collectPhones(pages),
    nameCandidates: collectNameCandidates(primary, homepage),
    potentialActions: extractActions(combined),
    availabilitySignal: extractAvailability(primary, pages),
    localBusinessNodes,
    organizationNodes,
  };
}

function extractName(primary: StructuredNode | null, pages: PageModel[]): Extracted<string | null> {
  const structured = primary ? textValue(primary.props["name"] ?? primary.props["legalName"]) : null;
  if (structured) {
    return { value: structured, provenance: "structured", source: `${primary!.syntax}:${primary!.types[0]}` };
  }
  const homepage = pages[0]!;
  const ogSiteName = collapse(String(homepage.$('meta[property="og:site_name"]').attr("content") ?? ""));
  if (ogSiteName) return { value: ogSiteName, provenance: "prose", source: "meta og:site_name" };
  const h1 = homepage.headings[0];
  if (h1) return { value: h1, provenance: "prose", source: "first heading" };
  if (homepage.title) return { value: homepage.title, provenance: "prose", source: "<title>" };
  return { value: null, provenance: "absent", source: null };
}

function extractAddress(primary: StructuredNode | null, pages: PageModel[]): Extracted<PostalAddress | null> {
  const fromNodes = [primary, ...pages.flatMap((page) => page.structured.nodes)].filter(Boolean) as StructuredNode[];
  for (const node of fromNodes) {
    const address = node.props["address"];
    if (!address) continue;
    const parsed = parsePostalAddress(address);
    if (parsed && (parsed.streetAddress || parsed.locality)) {
      return { value: parsed, provenance: "structured", source: `${node.syntax}:${node.types[0]}/address` };
    }
  }

  // Fall back to a US-style address in prose. Parseable, but only by guessing.
  const pattern =
    /\d{1,6}\s+[A-Za-z0-9.'\- ]{2,40}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Parkway|Pkwy|Highway|Hwy|Suite|Ste)\.?[,\s]+[A-Za-z .'\-]{2,30},?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?/;
  for (const page of pages) {
    const match = page.text.match(pattern);
    if (match) {
      return {
        value: {
          streetAddress: null,
          locality: null,
          region: null,
          postalCode: null,
          country: null,
          formatted: collapse(match[0]),
        },
        provenance: "prose",
        source: `visible text on ${page.url}`,
      };
    }
  }
  return { value: null, provenance: "absent", source: null };
}

function parsePostalAddress(value: unknown): PostalAddress | null {
  for (const item of toArray(value)) {
    if (typeof item === "string" && item.trim()) {
      return {
        streetAddress: null, locality: null, region: null, postalCode: null, country: null,
        formatted: collapse(item),
      };
    }
    if (item !== null && typeof item === "object") {
      const object = item as Record<string, unknown>;
      const address: PostalAddress = {
        streetAddress: textValue(object["streetAddress"]),
        locality: textValue(object["addressLocality"]),
        region: textValue(object["addressRegion"]),
        postalCode: textValue(object["postalCode"]),
        country: textValue(object["addressCountry"]),
        formatted: "",
      };
      address.formatted = collapse(
        [address.streetAddress, address.locality, address.region, address.postalCode, address.country]
          .filter(Boolean)
          .join(", "),
      );
      if (address.formatted) return address;
    }
  }
  return null;
}

function extractPhone(primary: StructuredNode | null, pages: PageModel[]): Extracted<string | null> {
  const nodes = [primary, ...pages.flatMap((page) => page.structured.nodes)].filter(Boolean) as StructuredNode[];
  for (const node of nodes) {
    const phone = textValue(node.props["telephone"]);
    if (phone) return { value: phone, provenance: "structured", source: `${node.syntax}:${node.types[0]}/telephone` };
    const contactPoint = node.props["contactPoint"];
    for (const point of toArray(contactPoint)) {
      if (point !== null && typeof point === "object") {
        const nested = textValue((point as Record<string, unknown>)["telephone"]);
        if (nested) return { value: nested, provenance: "structured", source: "ContactPoint/telephone" };
      }
    }
  }
  for (const page of pages) {
    // A tel: link is machine-actionable, but not structured business data.
    if (page.telLinks[0]) return { value: page.telLinks[0], provenance: "prose", source: `tel: link on ${page.url}` };
  }
  for (const page of pages) {
    if (page.phonesInText[0]) {
      return { value: page.phonesInText[0], provenance: "prose", source: `visible text on ${page.url}` };
    }
  }
  return { value: null, provenance: "absent", source: null };
}

function extractServices(
  combined: { nodes: StructuredNode[] },
  primary: StructuredNode | null,
  pages: PageModel[],
): Extracted<string[]> {
  const structured = new Set<string>();

  for (const node of findNodes({ nodes: combined.nodes, invalidJsonLdBlocks: [], jsonLdBlockCount: 0 }, (type) =>
    ["service", "offer", "product"].includes(stripSchemaPrefix(type).toLowerCase()),
  )) {
    const name = textValue(node.props["name"] ?? node.props["itemOffered"] ?? node.props["serviceType"]);
    if (name) structured.add(name);
  }

  for (const node of [primary, ...combined.nodes].filter(Boolean) as StructuredNode[]) {
    for (const key of ["hasOfferCatalog", "makesOffer", "hasOfferCatalogue", "serviceType", "knowsAbout"]) {
      for (const entry of toArray(node.props[key])) {
        if (typeof entry === "string" && entry.trim()) {
          structured.add(entry.trim());
          continue;
        }
        if (entry === null || typeof entry !== "object") continue;
        const object = entry as Record<string, unknown>;
        const listed = toArray(object["itemListElement"]);
        for (const item of listed) {
          const name = textValue(
            (item as Record<string, unknown>)?.["name"] ??
              ((item as Record<string, unknown>)?.["itemOffered"] as Record<string, unknown>)?.["name"] ??
              (item as Record<string, unknown>)?.["itemOffered"],
          );
          if (name) structured.add(name);
        }
        // A catalog's own name ("Plumbing services") is the heading over the list,
        // not a service you can book. Only take it when there is no list under it.
        if (listed.length === 0) {
          const own = textValue(object["name"]);
          if (own) structured.add(own);
        }
      }
    }
  }

  if (structured.size > 0) {
    return { value: [...structured].slice(0, 50), provenance: "structured", source: "Service/Offer/OfferCatalog" };
  }

  // Prose fallback: a services page or a heading-led list. Extractable only by guessing.
  const servicesPage = pages.find((page) => page.role === "services");
  const candidates: string[] = [];
  const source = servicesPage ?? pages[0]!;
  for (const heading of source.headings.slice(1)) {
    if (heading.length >= 3 && heading.length <= 60) candidates.push(heading);
  }
  for (const item of source.listItems) {
    if (item.length >= 3 && item.length <= 60) candidates.push(item);
  }
  const unique = [...new Set(candidates)];
  if (servicesPage && unique.length >= 3) {
    return { value: unique.slice(0, 30), provenance: "prose", source: `headings and list items on ${source.url}` };
  }
  if (unique.length >= 3 && /services?|what we do|our work/i.test(source.text)) {
    return { value: unique.slice(0, 30), provenance: "prose", source: `headings and list items on ${source.url}` };
  }
  return { value: [], provenance: "absent", source: null };
}

function extractHours(primary: StructuredNode | null, pages: PageModel[]): Extracted<OpeningHours[]> {
  const nodes = [primary, ...pages.flatMap((page) => page.structured.nodes)].filter(Boolean) as StructuredNode[];

  for (const node of nodes) {
    const spec = node.props["openingHoursSpecification"];
    const parsed: OpeningHours[] = [];
    for (const entry of toArray(spec)) {
      if (entry === null || typeof entry !== "object") continue;
      const object = entry as Record<string, unknown>;
      const days = toArray(object["dayOfWeek"]).map((day) => stripSchemaPrefix(String(textValue(day) ?? day)));
      parsed.push({
        days,
        opens: textValue(object["opens"]),
        closes: textValue(object["closes"]),
        raw: `${days.join(", ")} ${textValue(object["opens"]) ?? "?"}–${textValue(object["closes"]) ?? "?"}`,
      });
    }
    if (parsed.length > 0) {
      return { value: parsed, provenance: "structured", source: "openingHoursSpecification" };
    }

    // The older openingHours string form, e.g. "Mo-Fr 09:00-17:00". Still structured.
    const shorthand = toArray(node.props["openingHours"]).filter((entry) => typeof entry === "string") as string[];
    if (shorthand.length > 0) {
      return {
        value: shorthand.map((raw) => ({ days: [], opens: null, closes: null, raw })),
        provenance: "structured",
        source: "openingHours",
      };
    }
  }

  // Prose hours: a day name near a time on the same line.
  const pattern = new RegExp(
    `\\b(${DAY_NAMES.map((day) => `${day}|${day.slice(0, 3)}`).join("|")})\\b[^\\n]{0,40}?\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)`,
    "gi",
  );
  for (const page of pages) {
    const matches = page.text.match(pattern);
    if (matches && matches.length >= 2) {
      return {
        value: matches.slice(0, 7).map((raw) => ({ days: [], opens: null, closes: null, raw: collapse(raw) })),
        provenance: "prose",
        source: `visible text on ${page.url}`,
      };
    }
  }
  return { value: [], provenance: "absent", source: null };
}

function extractServiceArea(primary: StructuredNode | null, pages: PageModel[]): Extracted<string[]> {
  const nodes = [primary, ...pages.flatMap((page) => page.structured.nodes)].filter(Boolean) as StructuredNode[];
  const areas = new Set<string>();

  for (const node of nodes) {
    for (const key of ["areaServed", "serviceArea"]) {
      for (const entry of toArray(node.props[key])) {
        if (typeof entry === "string" && entry.trim()) {
          areas.add(entry.trim());
          continue;
        }
        if (entry === null || typeof entry !== "object") continue;
        const object = entry as Record<string, unknown>;
        const name = textValue(object["name"] ?? object["addressLocality"] ?? object["addressRegion"]);
        if (name) areas.add(name);
        const geoRadius = object["geoRadius"] ?? (object["geoMidpoint"] ? object["geoRadius"] : undefined);
        if (geoRadius) areas.add(`radius ${textValue(geoRadius) ?? String(geoRadius)}`);
        for (const code of toArray(object["postalCode"])) {
          const value = textValue(code);
          if (value) areas.add(value);
        }
      }
    }
    for (const code of toArray(node.props["areaServedPostalCode"])) {
      const value = textValue(code);
      if (value) areas.add(value);
    }
  }

  if (areas.size > 0) {
    return { value: [...areas].slice(0, 100), provenance: "structured", source: "areaServed / serviceArea" };
  }

  // A list of place names under a service-area heading is parseable-ish; vague prose is not.
  for (const page of pages) {
    const zips = [...new Set(page.text.match(/\b\d{5}\b/g) ?? [])];
    const hasServiceAreaContext = /service area|areas we serve|areas served|we serve|serving|proudly serve/i.test(page.text);
    if (hasServiceAreaContext && zips.length >= 3) {
      return { value: zips.slice(0, 100), provenance: "prose", source: `ZIP list on ${page.url}` };
    }
    if (hasServiceAreaContext) {
      const cityList = page.listItems.filter((item) => /^[A-Z][A-Za-z .'\-]{2,28}(?:,\s*[A-Z]{2})?$/.test(item));
      if (cityList.length >= 3) {
        return { value: cityList.slice(0, 100), provenance: "prose", source: `place list on ${page.url}` };
      }
      const vague = page.text.match(/(?:serving|we serve|proudly serve)[^.]{0,120}/i);
      if (vague) {
        return { value: [collapse(vague[0])], provenance: "prose", source: `prose on ${page.url}` };
      }
    }
  }
  return { value: [], provenance: "absent", source: null };
}

function extractPricing(
  combined: { nodes: StructuredNode[] },
  primary: StructuredNode | null,
  pages: PageModel[],
): Extracted<PricingSignal[]> {
  const signals: PricingSignal[] = [];

  for (const node of [primary, ...combined.nodes].filter(Boolean) as StructuredNode[]) {
    const priceRange = textValue(node.props["priceRange"]);
    if (priceRange) signals.push({ kind: "priceRange", value: priceRange });
    const price = textValue(node.props["price"]);
    if (price) {
      const currency = textValue(node.props["priceCurrency"]) ?? "";
      signals.push({ kind: "offer", value: collapse(`${currency} ${price}`) });
    }
    for (const spec of toArray(node.props["priceSpecification"])) {
      const value = textValue((spec as Record<string, unknown>)?.["price"] ?? spec);
      if (value) signals.push({ kind: "priceSpecification", value });
    }
  }

  if (signals.length > 0) {
    return { value: dedupeSignals(signals).slice(0, 30), provenance: "structured", source: "priceRange / Offer / priceSpecification" };
  }

  for (const page of pages) {
    const matches = page.text.match(/(?:\$\s?\d[\d,]*(?:\.\d{2})?(?:\s*(?:–|-|to)\s*\$?\d[\d,]*)?)|(?:starting at [^.]{0,40})|(?:free estimates?)/gi);
    if (matches && matches.length > 0) {
      return {
        value: dedupeSignals(matches.slice(0, 20).map((value) => ({ kind: "prose" as const, value: collapse(value) }))),
        provenance: "prose",
        source: `visible text on ${page.url}`,
      };
    }
  }
  return { value: [], provenance: "absent", source: null };
}

function dedupeSignals(signals: PricingSignal[]): PricingSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.kind}:${signal.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractActions(combined: { nodes: StructuredNode[] }): ActionSignal[] {
  const actions: ActionSignal[] = [];
  for (const node of combined.nodes) {
    for (const entry of toArray(node.props["potentialAction"])) {
      if (entry === null || typeof entry !== "object") continue;
      const object = entry as Record<string, unknown>;
      const type = toArray(object["@type"]).map((t) => stripSchemaPrefix(String(t)))[0] ?? "Action";
      const target = resolveActionTarget(object["target"] ?? object["url"]);
      actions.push({
        type,
        target,
        machineTargetable: Boolean(target && /^https?:/i.test(target)),
      });
    }
    // An Action node can also stand on its own rather than hanging off potentialAction.
    if (node.types.some((type) => /Action$/i.test(stripSchemaPrefix(type)))) {
      const target = resolveActionTarget(node.props["target"] ?? node.props["url"]);
      actions.push({
        type: stripSchemaPrefix(node.types[0]!),
        target,
        machineTargetable: Boolean(target && /^https?:/i.test(target)),
      });
    }
  }
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.type}:${action.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveActionTarget(value: unknown): string | null {
  for (const item of toArray(value)) {
    if (typeof item === "string" && item.trim()) return item.trim();
    if (item !== null && typeof item === "object") {
      const object = item as Record<string, unknown>;
      const url = textValue(object["urlTemplate"] ?? object["url"]);
      if (url) return url;
    }
  }
  return null;
}

function extractAvailability(primary: StructuredNode | null, pages: PageModel[]): AvailabilitySignal | null {
  const nodes = [primary, ...pages.flatMap((page) => page.structured.nodes)].filter(Boolean) as StructuredNode[];
  for (const node of nodes) {
    if (toArray(node.props["specialOpeningHoursSpecification"]).length > 0) {
      return {
        kind: "structured-special-hours",
        detail: "The page publishes specialOpeningHoursSpecification, so exceptions to normal hours are machine-readable.",
      };
    }
  }
  for (const page of pages) {
    if (/\bopen now\b|\bclosed now\b|\bcurrently open\b|\bcurrently closed\b|\bopen today\b/i.test(page.text)) {
      return { kind: "open-now-indicator", detail: `An open/closed indicator appears on ${page.url}.` };
    }
    if (page.bookingProviders.length > 0) {
      return {
        kind: "booking-widget-availability",
        detail: `${page.bookingProviders.join(", ")} is embedded, which exposes live slots to anything that can read that provider.`,
      };
    }
  }
  return null;
}

function collectPhones(pages: PageModel[]): string[] {
  const phones = new Set<string>();
  for (const page of pages) {
    for (const phone of [...page.telLinks, ...page.phonesInText]) {
      const normalized = normalizePhone(phone);
      if (normalized.length >= 7) phones.add(normalized);
    }
    for (const node of page.structured.nodes) {
      const value = textValue(node.props["telephone"]);
      if (value) {
        const normalized = normalizePhone(value);
        if (normalized.length >= 7) phones.add(normalized);
      }
    }
  }
  return [...phones];
}

function collectNameCandidates(primary: StructuredNode | null, homepage: PageModel): string[] {
  const candidates = new Set<string>();
  if (primary) {
    const name = textValue(primary.props["name"]);
    if (name) candidates.add(name);
  }
  const ogSiteName = collapse(String(homepage.$('meta[property="og:site_name"]').attr("content") ?? ""));
  if (ogSiteName) candidates.add(ogSiteName);
  if (homepage.headings[0]) candidates.add(homepage.headings[0]);
  if (homepage.title) candidates.add(homepage.title);
  return [...candidates];
}
