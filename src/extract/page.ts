import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { FetchOutcome } from "../fetcher.ts";
import type { PageRole } from "../types.ts";
import { extractStructuredData, type StructuredData } from "./structuredData.ts";

export interface FormField {
  name: string;
  type: string;
  /** True when a <label for>, wrapping <label>, aria-label, or placeholder names the field. */
  labeled: boolean;
  labelSource: "label-for" | "label-wrap" | "aria-label" | "aria-labelledby" | "placeholder" | "title" | "none";
  labelText: string;
  required: boolean;
}

export interface FormModel {
  action: string | null;
  method: string;
  fields: FormField[];
  labeledFieldCount: number;
  /** Field names that look like a quote/contact intent (name, email, phone, message, service). */
  intentSignals: string[];
  hasCaptcha: boolean;
  captchaKind: string | null;
  /** Best guess at what the form is for, from surrounding text and field names. */
  purpose: "quote" | "contact" | "booking" | "newsletter" | "search" | "login" | "unknown";
}

export interface LinkModel {
  href: string;
  absolute: string | null;
  text: string;
  rel: string;
}

export interface PageModel {
  url: string;
  role: PageRole;
  status: number | null;
  elapsedMs: number;
  html: string;
  $: CheerioAPI;
  title: string;
  metaDescription: string;
  /** Visible text with script/style/noscript stripped. */
  text: string;
  /** Length of visible text — the core input to the JS-dependency check. */
  textLength: number;
  structured: StructuredData;
  links: LinkModel[];
  forms: FormModel[];
  telLinks: string[];
  mailtoLinks: string[];
  /** Phone numbers found in visible text, whether or not they are linked. */
  phonesInText: string[];
  headings: string[];
  listItems: string[];
  /** Signals that real content only appears after JavaScript runs. */
  jsDependency: JsDependencySignal;
  blockSignal: string | null;
  /** Third-party booking/scheduling providers referenced anywhere in the markup. */
  bookingProviders: string[];
}

export interface JsDependencySignal {
  requiresJs: boolean;
  confidence: "high" | "medium" | "none";
  /**
   * What we actually observed. "javascript" means there is evidence the content is
   * assembled in the browser. "thin-html" means the served HTML is nearly empty but
   * nothing points at JavaScript as the cause — we say that instead of guessing.
   */
  kind: "javascript" | "thin-html" | null;
  reasons: string[];
  framework: string | null;
  noscriptWarning: string | null;
}

const CAPTCHA_PATTERNS: Array<{ pattern: RegExp; kind: string }> = [
  { pattern: /g-recaptcha|recaptcha\/api\.js|grecaptcha/i, kind: "reCAPTCHA" },
  { pattern: /hcaptcha\.com|h-captcha/i, kind: "hCaptcha" },
  { pattern: /challenges\.cloudflare\.com\/turnstile|cf-turnstile/i, kind: "Cloudflare Turnstile" },
  { pattern: /friendlycaptcha|frc-captcha/i, kind: "Friendly Captcha" },
];

/** Booking/scheduling providers a machine can at least recognize and follow. */
const BOOKING_PROVIDERS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /calendly\.com/i, name: "Calendly" },
  { pattern: /acuityscheduling\.com|squarespacescheduling\.com/i, name: "Acuity Scheduling" },
  { pattern: /squareup\.com\/appointments|square\.site/i, name: "Square Appointments" },
  { pattern: /opentable\.com/i, name: "OpenTable" },
  { pattern: /resy\.com/i, name: "Resy" },
  { pattern: /booksy\.com/i, name: "Booksy" },
  { pattern: /setmore\.com/i, name: "Setmore" },
  { pattern: /mindbodyonline\.com|mindbody\.io/i, name: "Mindbody" },
  { pattern: /housecallpro\.com/i, name: "Housecall Pro" },
  { pattern: /servicetitan\.com/i, name: "ServiceTitan" },
  { pattern: /getjobber\.com|jobber\.com/i, name: "Jobber" },
  { pattern: /schedulicity\.com/i, name: "Schedulicity" },
  { pattern: /vagaro\.com/i, name: "Vagaro" },
  { pattern: /simplybook\.me/i, name: "SimplyBook.me" },
  { pattern: /appointmentcore|youcanbook\.me/i, name: "YouCanBook.me" },
  { pattern: /tidycal\.com/i, name: "TidyCal" },
  { pattern: /cal\.com/i, name: "Cal.com" },
  { pattern: /doctolib|zocdoc\.com/i, name: "Zocdoc" },
  { pattern: /fareharbor\.com|checkfront\.com|peek\.com/i, name: "FareHarbor/Checkfront/Peek" },
  { pattern: /angi\.com\/booking|thumbtack\.com/i, name: "Thumbtack/Angi" },
];

const JS_FRAMEWORK_MARKERS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i, name: "React (empty #root)" },
  { pattern: /<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i, name: "Vue/Angular (empty #app)" },
  { pattern: /<app-root[^>]*>\s*<\/app-root>/i, name: "Angular" },
  { pattern: /__NEXT_DATA__/i, name: "Next.js" },
  { pattern: /__NUXT__/i, name: "Nuxt" },
  { pattern: /window\.__remixContext/i, name: "Remix" },
  { pattern: /data-reactroot/i, name: "React" },
];

export function buildPageModel(outcome: FetchOutcome, role: PageRole): PageModel {
  const html = outcome.body;
  const $ = cheerio.load(html);

  const working = $.root().clone();
  working.find("script, style, noscript, template, svg").remove();
  const text = collapse(working.text());

  const links: LinkModel[] = $("a[href]")
    .toArray()
    .map((element) => {
      const node = $(element);
      const href = String(node.attr("href") ?? "").trim();
      return {
        href,
        absolute: toAbsolute(href, outcome.finalUrl),
        text: collapse(node.text()),
        rel: String(node.attr("rel") ?? ""),
      };
    })
    .filter((link) => link.href.length > 0);

  const structured = extractStructuredData($);

  return {
    url: outcome.finalUrl,
    role,
    status: outcome.status,
    elapsedMs: outcome.elapsedMs,
    html,
    $,
    title: collapse($("title").first().text()),
    metaDescription: collapse(String($('meta[name="description"]').attr("content") ?? "")),
    text,
    textLength: text.length,
    structured,
    links,
    forms: $("form").toArray().map((element) => buildFormModel($, element)),
    telLinks: links
      .filter((link) => link.href.toLowerCase().startsWith("tel:"))
      .map((link) => link.href.slice(4).trim())
      .filter(Boolean),
    mailtoLinks: links
      .filter((link) => link.href.toLowerCase().startsWith("mailto:"))
      .map((link) => link.href.slice(7).split("?")[0]!.trim())
      .filter(Boolean),
    phonesInText: findPhoneNumbers(text),
    headings: $("h1, h2, h3").toArray().map((element) => collapse($(element).text())).filter(Boolean),
    listItems: $("li").toArray().map((element) => collapse($(element).text())).filter(Boolean),
    jsDependency: detectJsDependency($, html, text, structured),
    blockSignal: outcome.blockSignal,
    bookingProviders: BOOKING_PROVIDERS.filter(({ pattern }) => pattern.test(html)).map(({ name }) => name),
  };
}

function buildFormModel($: CheerioAPI, element: Element): FormModel {
  const form = $(element);
  const html = $.html(form);
  const fields: FormField[] = [];

  form.find("input, select, textarea").each((_, fieldEl) => {
    const field = $(fieldEl);
    const type = String(field.attr("type") ?? (fieldEl as { tagName?: string }).tagName ?? "text").toLowerCase();
    if (["hidden", "submit", "button", "image", "reset"].includes(type)) return;

    const name = String(field.attr("name") ?? field.attr("id") ?? "").trim();
    const id = String(field.attr("id") ?? "").trim();

    let labelSource: FormField["labelSource"] = "none";
    let labelText = "";

    if (id) {
      const forLabel = form.find(`label[for="${cssEscape(id)}"]`).first();
      if (forLabel.length > 0 && collapse(forLabel.text())) {
        labelSource = "label-for";
        labelText = collapse(forLabel.text());
      }
    }
    if (labelSource === "none") {
      const wrapping = field.closest("label");
      if (wrapping.length > 0 && collapse(wrapping.text())) {
        labelSource = "label-wrap";
        labelText = collapse(wrapping.text());
      }
    }
    if (labelSource === "none" && field.attr("aria-label")) {
      labelSource = "aria-label";
      labelText = collapse(String(field.attr("aria-label")));
    }
    if (labelSource === "none" && field.attr("aria-labelledby")) {
      const referenced = $(`#${cssEscape(String(field.attr("aria-labelledby")).split(/\s+/)[0] ?? "")}`);
      if (referenced.length > 0) {
        labelSource = "aria-labelledby";
        labelText = collapse(referenced.text());
      }
    }
    if (labelSource === "none" && field.attr("placeholder")) {
      labelSource = "placeholder";
      labelText = collapse(String(field.attr("placeholder")));
    }
    if (labelSource === "none" && field.attr("title")) {
      labelSource = "title";
      labelText = collapse(String(field.attr("title")));
    }

    fields.push({
      name,
      type,
      // A placeholder is a weak label — it disappears on input and isn't announced
      // as a name. It counts as labeled only for machines reading raw markup.
      labeled: labelSource !== "none",
      labelSource,
      labelText,
      required: field.attr("required") !== undefined || field.attr("aria-required") === "true",
    });
  });

  const captcha = CAPTCHA_PATTERNS.find(({ pattern }) => pattern.test(html));
  const haystack = `${fields.map((f) => `${f.name} ${f.labelText}`).join(" ")} ${collapse(form.text())} ${String(form.attr("action") ?? "")} ${String(form.attr("id") ?? "")} ${String(form.attr("class") ?? "")}`.toLowerCase();

  const intentSignals: string[] = [];
  for (const [signal, pattern] of Object.entries({
    name: /\bname\b|full[\s_-]?name|first[\s_-]?name/,
    email: /\bemail\b|e-mail/,
    phone: /\bphone\b|telephone|\bmobile\b|\bcell\b/,
    message: /\bmessage\b|comment|describe|details|tell us/,
    service: /\bservice\b|job type|project type|what do you need/,
    address: /\baddress\b|zip|postal|city|street/,
    date: /\bdate\b|when|preferred time|appointment/,
  })) {
    if (pattern.test(haystack)) intentSignals.push(signal);
  }

  return {
    action: String(form.attr("action") ?? "") || null,
    method: String(form.attr("method") ?? "get").toLowerCase(),
    fields,
    labeledFieldCount: fields.filter((field) => field.labeled).length,
    intentSignals,
    hasCaptcha: Boolean(captcha),
    captchaKind: captcha?.kind ?? null,
    purpose: classifyFormPurpose(haystack, fields),
  };
}

function classifyFormPurpose(haystack: string, fields: FormField[]): FormModel["purpose"] {
  if (/\bpassword\b/.test(haystack) || fields.some((f) => f.type === "password")) return "login";
  if (/\bsearch\b/.test(haystack) && fields.length <= 2) return "search";
  if (/book|appointment|reservation|schedule|reserve/.test(haystack)) return "booking";
  if (/quote|estimate|pricing|get a price|free quote/.test(haystack)) return "quote";
  if (/subscribe|newsletter|mailing list|sign up for updates/.test(haystack) && fields.length <= 3) {
    return "newsletter";
  }
  if (/contact|get in touch|message us|send us/.test(haystack)) return "contact";
  if (fields.some((f) => f.type === "email") && fields.length >= 3) return "contact";
  return "unknown";
}

/**
 * We do not run a headless browser — the spec is explicit that a site needing JS to
 * expose its content is a finding, not an obstacle to route around. This detects
 * that condition from the raw HTML so it can be reported honestly.
 *
 * Two rules keep it from crying wolf. A page carrying substantive structured data
 * is serving real content whatever else JavaScript adds. And a nearly-empty page
 * with no evidence of client-side rendering is reported as a nearly-empty page,
 * not as a JavaScript problem we cannot actually see.
 */
function detectJsDependency(
  $: CheerioAPI,
  html: string,
  text: string,
  structured: StructuredData,
): JsDependencySignal {
  const none: JsDependencySignal = {
    requiresJs: false,
    confidence: "none",
    kind: null,
    reasons: [],
    framework: null,
    noscriptWarning: null,
  };

  let framework: string | null = null;
  for (const marker of JS_FRAMEWORK_MARKERS) {
    if (marker.pattern.test(html)) {
      framework = marker.name;
      break;
    }
  }

  const noscript = collapse($("noscript").text());
  const noscriptWarning = /enable javascript|requires javascript|javascript is (?:required|disabled)|turn on javascript/i.test(noscript)
    ? noscript.slice(0, 300)
    : null;

  // Elements that carry real content, as opposed to chrome and script tags.
  const contentElements = $("h1, h2, h3, h4, h5, h6, p, li, td, dd, blockquote, figcaption, label, legend")
    .toArray()
    .filter((element) => collapse($(element).text()).length >= 3).length;

  // Structured data with substance in it proves the server sent usable content,
  // whatever the visible text length happens to be.
  const substantiveNodes = structured.nodes.filter(
    (node) => Object.keys(node.props).filter((key) => !key.startsWith("@")).length >= 3,
  ).length;
  if (substantiveNodes > 0 && contentElements >= 3) return { ...none, framework, noscriptWarning };

  const nearlyEmpty = text.length < 400 && contentElements < 6;
  if (!nearlyEmpty && !noscriptWarning) return { ...none, framework, noscriptWarning };

  // JSON-LD is data, not behaviour — counting it as "script weight" would penalise
  // exactly the markup we are asking businesses to add.
  const executableScriptLength = $("script")
    .toArray()
    .filter((element) => !/ld\+json/i.test(String($(element).attr("type") ?? "")))
    .reduce((sum, element) => sum + ($(element).html()?.length ?? 0), 0);
  const bodyMarkupLength = $("body").html()?.length ?? html.length;
  const scriptHeavy = bodyMarkupLength > 0 && executableScriptLength / bodyMarkupLength > 3;

  const reasons: string[] = [];
  if (nearlyEmpty) {
    reasons.push(
      `The served HTML contains ${text.length} characters of visible text across ${contentElements} content elements.`,
    );
  }
  if (noscriptWarning) reasons.push("The page carries a noscript notice telling visitors to enable JavaScript.");
  if (framework) reasons.push(`The page ships a ${framework} shell with the content left to JavaScript.`);
  if (scriptHeavy) reasons.push("The page is mostly script, with little content in the HTML itself.");

  const hasJsEvidence = Boolean(framework || noscriptWarning || scriptHeavy);
  if (!hasJsEvidence) {
    return {
      requiresJs: true,
      confidence: "medium",
      kind: "thin-html",
      reasons,
      framework,
      noscriptWarning,
    };
  }

  const highConfidence =
    (nearlyEmpty && (framework !== null || scriptHeavy)) ||
    (noscriptWarning !== null && text.length < 800);

  return {
    requiresJs: true,
    confidence: highConfidence ? "high" : "medium",
    kind: "javascript",
    reasons,
    framework,
    noscriptWarning,
  };
}

/** North-American-style phone numbers, plus a loose international form. */
const PHONE_PATTERN =
  /(?:\+?1[\s.\-]?)?(?:\(\d{3}\)|\d{3})[\s.\-]?\d{3}[\s.\-]\d{4}\b|\+\d{1,3}[\s.\-]?\d{2,4}[\s.\-]?\d{2,4}[\s.\-]?\d{2,4}/g;

export function findPhoneNumbers(text: string): string[] {
  const matches = text.match(PHONE_PATTERN) ?? [];
  return [...new Set(matches.map((match) => match.trim()))];
}

/** Compare phone numbers by digits only, so (555) 123-4567 and 555.123.4567 match. */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

export function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function toAbsolute(href: string, base: string): string | null {
  try {
    if (/^(mailto|tel|javascript|sms|data):/i.test(href)) return null;
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
