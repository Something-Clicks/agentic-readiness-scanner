import type { PageModel, FormModel } from "../extract/page.ts";
import type { BusinessFacts } from "../extract/business.ts";
import type { CallableResult, CheckStatus, TaskPathStep } from "../types.ts";
import { listPhrase } from "./readable.ts";

/**
 * CALLABLE — the task-path trace from the spec.
 *
 * An agent trying to actually hire this business walks five steps in order. Each is
 * worth 0–20 and they sum to 100. The point is not the total, it is *where the path
 * breaks*: the earliest low-scoring step is what the "Biggest problem" line reports,
 * because a break at step 2 makes steps 3–5 unreachable no matter how well built
 * they are.
 */
const STEP_MAX = 20;

export function scoreCallable(pages: PageModel[], facts: BusinessFacts): CallableResult {
  const steps: TaskPathStep[] = [
    stepUnderstandServices(facts),
    stepDetermineServiceArea(facts),
    stepDetermineHours(facts),
    stepRequestQuote(pages, facts),
    stepBookOrContact(pages, facts),
  ];

  const score = Math.max(0, Math.min(100, steps.reduce((sum, step) => sum + step.earned, 0)));

  // Lowest score wins; on a tie the earliest step wins, because a break early in the
  // path is what makes everything after it unreachable.
  const breaksAt = steps.reduce((worst, step) => (step.earned < worst.earned ? step : worst), steps[0]!);

  return { name: "CALLABLE", score, checks: steps, steps, breaksAt, penalties: [] };
}

function stepUnderstandServices(facts: BusinessFacts): TaskPathStep {
  const { provenance, value } = facts.services;

  if (provenance === "structured" && value.length > 0) {
    return step(1, "Understand services", STEP_MAX, {
      finding: `An agent can pull a specific list of ${value.length} service${value.length === 1 ? "" : "s"} straight out of the page's structured data.`,
      evidence: { services: value, provenance },
    });
  }
  if (provenance === "prose" && value.length > 0) {
    return step(1, "Understand services", 8, {
      finding: `Your services are on the page as text. An agent can read the words but cannot tell a service from a headline, so it ends up with a rough guess at what you do.`,
      recommendation: "Mark each service up as a Service so the list is stated rather than inferred.",
      evidence: { services: value.slice(0, 10), provenance },
    });
  }
  return step(1, "Understand services", 0, {
    finding: "An agent cannot work out what you actually do from this site.",
    recommendation: "List your services by name on a services page and mark each one up as a Service.",
    evidence: { provenance },
  });
}

function stepDetermineServiceArea(facts: BusinessFacts): TaskPathStep {
  const { provenance, value, source } = facts.serviceArea;

  if (provenance === "structured" && value.length > 0) {
    return step(2, "Determine service area", STEP_MAX, {
      finding: `Your service area is published as structured data (${value.length} entr${value.length === 1 ? "y" : "ies"}), so an agent can check a specific address against it.`,
      evidence: { serviceArea: value.slice(0, 20), provenance },
    });
  }

  const isVaguePhrase =
    value.length === 1 && /greater|surrounding|metro|and beyond|area\b/i.test(value[0] ?? "") && (value[0]?.length ?? 0) > 25;

  if (provenance === "prose" && value.length >= 3 && !isVaguePhrase) {
    return step(2, "Determine service area", 10, {
      finding: `A list of places you cover appears on the page (${value.slice(0, 5).join(", ")}${value.length > 5 ? `, and ${value.length - 5} more` : ""}), but it is plain text. An agent has to guess whether it is a service area or a list of nearby landmarks.`,
      recommendation: "Add areaServed to your LocalBusiness data with the cities, regions, or ZIP codes you cover.",
      evidence: { serviceArea: value.slice(0, 20), provenance, source },
    });
  }

  if (provenance === "prose" && value.length > 0) {
    return step(2, "Determine service area", 4, {
      finding: `The only statement of where you work is prose: "${truncate(value[0] ?? "", 90)}". A customer twenty minutes away cannot tell from that whether you come out to them, and neither can an agent.`,
      recommendation: "Replace the phrase with an actual list of cities or ZIP codes, and add areaServed to your structured data.",
      evidence: { serviceArea: value, provenance, source },
    });
  }

  return step(2, "Determine service area", 0, {
    finding: "Nothing on the site says where you work. Anything sorting local businesses by who covers a given address has no way to place you.",
    recommendation: "Publish the cities or ZIP codes you cover, and add areaServed to your LocalBusiness data.",
    evidence: { provenance },
  });
}

function stepDetermineHours(facts: BusinessFacts): TaskPathStep {
  const { provenance, value } = facts.hours;
  const availability = facts.availabilitySignal;
  // Structured hours are worth 14 of the 20; a live availability signal adds the rest.
  const base = provenance === "structured" ? 14 : provenance === "prose" ? 6 : 0;
  const bonus = availability ? 6 : 0;
  const earned = base + bonus;

  if (base === 0 && bonus === 0) {
    return step(3, "Determine hours and availability", 0, {
      finding: "There are no hours on the site and no sign of whether you are open right now.",
      recommendation: "Publish your hours and add openingHoursSpecification to your structured data.",
      evidence: { provenance },
    });
  }

  const parts: string[] = [];
  if (provenance === "structured") parts.push(`Hours are published as structured data (${value.length} entr${value.length === 1 ? "y" : "ies"})`);
  else if (provenance === "prose") parts.push("Hours appear on the page as text, not as structured data");
  else parts.push("There are no hours on the site");

  if (availability) parts.push(availability.detail);
  else parts.push("There is no live availability signal — nothing an agent can check to see whether you can take a job today.");

  return step(3, "Determine hours and availability", earned, {
    finding: parts.map((part) => part.replace(/\.\s*$/, "")).join(". ") + ".",
    recommendation:
      provenance !== "structured"
        ? "Add openingHoursSpecification with 24-hour opens/closes times for each day."
        : availability
          ? undefined
          : "Add an open-now indicator or connect a booking tool that exposes real slots.",
    evidence: { provenance, hours: value.slice(0, 7), availability },
  });
}

function stepRequestQuote(pages: PageModel[], facts: BusinessFacts): TaskPathStep {
  const forms = pages.flatMap((page) => page.forms.map((form) => ({ form, page })));
  const relevant = forms.filter(({ form }) => ["quote", "contact", "booking", "unknown"].includes(form.purpose) && form.fields.length >= 2);

  const quoteAction = facts.potentialActions.find(
    (action) => /Quote|Order|Reserve|Contact/i.test(action.type) && action.machineTargetable,
  );

  if (relevant.length === 0) {
    if (quoteAction) {
      return step(4, "Request a quote", 14, {
        finding: `There is no quote form on the pages we read, but your structured data publishes a ${quoteAction.type} pointing at ${quoteAction.target}. An agent can follow that.`,
        recommendation: "Add a labeled quote form as well, so a person and an agent both have a path.",
        evidence: { potentialAction: quoteAction },
      });
    }
    return step(4, "Request a quote", 0, {
      finding: "There is no way to ask for a quote in writing. Nothing on the pages we read accepts a request — it is a phone call or nothing.",
      recommendation: "Add a quote form with clearly labeled fields for name, contact details, and what the job is.",
      evidence: { formsFound: forms.length },
    });
  }

  // Score the best available form.
  const scored = relevant.map(({ form, page }) => ({ form, page, score: scoreForm(form) }));
  const best = scored.reduce((a, b) => (b.score.earned > a.score.earned ? b : a));
  const earned = Math.min(STEP_MAX, best.score.earned + (quoteAction ? 3 : 0));

  return step(4, "Request a quote", earned, {
    finding: best.score.finding,
    recommendation: best.score.recommendation,
    evidence: {
      url: best.page.url,
      purpose: best.form.purpose,
      fieldCount: best.form.fields.length,
      labeledFieldCount: best.form.labeledFieldCount,
      labelSources: best.form.fields.map((field) => ({ name: field.name, type: field.type, labelSource: field.labelSource })),
      captcha: best.form.captchaKind,
      intentSignals: best.form.intentSignals,
      potentialAction: quoteAction ?? null,
    },
  });
}

function scoreForm(form: FormModel): { earned: number; finding: string; recommendation?: string } {
  const labeledRatio = form.fields.length === 0 ? 0 : form.labeledFieldCount / form.fields.length;
  // A placeholder is a weaker label than a real <label> — it names the field in the
  // markup but nothing else. Count it, discount it.
  const realLabels = form.fields.filter((field) => field.labelSource === "label-for" || field.labelSource === "label-wrap").length;
  const realRatio = form.fields.length === 0 ? 0 : realLabels / form.fields.length;

  const kind = form.purpose === "unknown" ? "form" : `${form.purpose} form`;

  if (labeledRatio < 0.5) {
    return {
      earned: 6,
      finding: `The ${kind} we found has ${form.fields.length} fields and only ${form.labeledFieldCount} of them are labeled in the HTML. This is a human form only — an agent filling it in has to guess which box is the phone number.`,
      recommendation: "Give every field a <label for> and a meaningful name attribute.",
    };
  }

  if (form.hasCaptcha) {
    return {
      earned: 12,
      finding: `The ${kind} has labeled fields, but it is behind ${form.captchaKind}. That is a wall by design: an agent acting for a customer cannot get past it, and will move on to a business it can reach.`,
      recommendation: `Keep ${form.captchaKind} if you need it for spam, and add a second path an agent can use — a labeled email address, a booking link, or an endpoint.`,
    };
  }

  if (realRatio >= 0.7) {
    return {
      earned: 20,
      finding: `The ${kind} has ${form.fields.length} clearly labeled fields (${listPhrase(form.intentSignals.slice(0, 4))}) and no CAPTCHA. An agent can fill this in on a customer's behalf.`,
    };
  }

  return {
    earned: 15,
    finding: `The ${kind} has ${form.fields.length} fields and no CAPTCHA, but ${form.fields.length - realLabels} of them are named only by a placeholder. Placeholders disappear as soon as text is typed and are not a reliable field name.`,
    recommendation: "Replace placeholder-only fields with real <label for> elements.",
  };
}

function stepBookOrContact(pages: PageModel[], facts: BusinessFacts): TaskPathStep {
  const bookingAction = facts.potentialActions.find(
    (action) => /Reserve|Order|Schedule|Book/i.test(action.type) && action.machineTargetable,
  );
  const providers = [...new Set(pages.flatMap((page) => page.bookingProviders))];
  const telLinks = [...new Set(pages.flatMap((page) => page.telLinks))];
  const mailtoLinks = [...new Set(pages.flatMap((page) => page.mailtoLinks))];
  const bookingForm = pages.flatMap((page) => page.forms).find((form) => form.purpose === "booking");
  const jsOnly = pages.filter((page) => page.jsDependency.confidence === "high");
  const phoneInTextOnly = telLinks.length === 0 && pages.some((page) => page.phonesInText.length > 0);

  const evidence = {
    potentialAction: bookingAction ?? null,
    bookingProviders: providers,
    telLinks,
    mailtoLinks,
    hasBookingForm: Boolean(bookingForm),
    javascriptOnlyPages: jsOnly.map((page) => page.url),
  };

  if (bookingAction) {
    return step(5, "Book or contact", STEP_MAX, {
      finding: `Your structured data publishes a ${bookingAction.type} pointing at ${bookingAction.target}. That is a booking path an agent can follow without a human in the loop.`,
      evidence,
    });
  }

  if (providers.length > 0) {
    const withContact = telLinks.length > 0 || mailtoLinks.length > 0;
    return step(5, "Book or contact", withContact ? 16 : 14, {
      finding: `${listPhrase(providers)} ${providers.length === 1 ? "is" : "are"} embedded on the site. An agent that recognizes that provider can follow the link into a real booking flow; one that does not, cannot.`,
      recommendation:
        "Add a ReserveAction to your structured data pointing at the booking URL, so the path is stated on your own site rather than left to the widget.",
      evidence,
    });
  }

  if (bookingForm) {
    return step(5, "Book or contact", 12, {
      finding: "There is a booking form on the site, but no structured booking action. An agent can see the form; it cannot tell whether submitting it books anything or just sends a message.",
      recommendation: "Add a ReserveAction to your structured data pointing at the booking page.",
      evidence,
    });
  }

  if (telLinks.length > 0 || mailtoLinks.length > 0) {
    const paths = [
      telLinks.length > 0 ? `a tel: link (${telLinks[0]})` : null,
      mailtoLinks.length > 0 ? `a mailto: link (${mailtoLinks[0]})` : null,
    ].filter(Boolean) as string[];
    return step(5, "Book or contact", 10, {
      finding: `The end of the path is ${listPhrase(paths)}. An agent can hand a customer your number or draft an email, but it cannot book anything — the last step still needs a person on the phone.`,
      recommendation:
        "Add a booking path a machine can complete: a scheduling tool, or a ReserveAction in your structured data pointing at where a booking is actually made.",
      evidence,
    });
  }

  if (phoneInTextOnly) {
    return step(5, "Book or contact", 4, {
      finding:
        "Your phone number is printed on the page but never linked. Tapping it on a phone does nothing, and an agent reading the page has to pattern-match a number out of the text and hope it is the right one.",
      recommendation: "Wrap the number in a tel: link, and add a booking path a machine can complete.",
      evidence,
    });
  }

  if (jsOnly.length > 0) {
    return step(5, "Book or contact", 0, {
      finding:
        "The path ends nowhere. The pages we fetched are assembled by JavaScript, so whatever booking or contact option exists in a browser is not in the HTML the server sends. Most crawlers see what we saw: nothing.",
      recommendation: "Serve your contact details and booking link in the HTML itself, not only after JavaScript runs.",
      evidence,
    });
  }

  return step(5, "Book or contact", 0, {
    finding: "There is no way to reach you from these pages — no linked phone number, no email link, no booking tool.",
    recommendation: "Add a tel: link and an email link at minimum, and a booking path if you take appointments.",
    evidence,
  });
}

function step(
  number: number,
  label: string,
  earned: number,
  rest: { finding: string; recommendation?: string; evidence?: Record<string, unknown> },
): TaskPathStep {
  return {
    step: number,
    id: `callable.step_${number}`,
    label,
    earned: Math.max(0, Math.min(STEP_MAX, Math.round(earned))),
    possible: STEP_MAX,
    status: statusFor(earned, STEP_MAX),
    finding: rest.finding,
    recommendation: rest.recommendation,
    evidence: rest.evidence,
  };
}

function statusFor(earned: number, possible: number): CheckStatus {
  const ratio = earned / possible;
  if (ratio >= 0.9) return "pass";
  if (ratio > 0) return "partial";
  return "fail";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
