# Brand — for use in this codebase

This covers only what code/UI needs (logo, color, voice for generated copy). Full brand guidelines, if you build them out further, belong in a shared doc outside this repo — same as the business model and pricing docs.

## Name

**Something Clicks.** Established — domain, logo, and existing infrastructure are already built around this name. Not up for reconsideration.

## Product names

**Scan, Fix, Monitor** — the only names used on the website, in checkout, in the app, and in this codebase. Do not use anything longer or more descriptive in these contexts.

**Exception — Google Business Profile product listings only:** use "AI Visibility Scan," "AI Visibility Fix," "AI Visibility Monitor." GBP listings need a descriptive standalone name since a bare single word doesn't read as a product outside the context of the site. This naming is scoped to GBP only — nothing else changes.

## Logo

`docs/logo.png` — a location pin merged with a cursor arrow. Reads as "click" + "location," a literal match for the name.

## Color

Pulled directly from the logo file (not approximated):

| Swatch | Hex | Use |
|---|---|---|
| Indigo blue | `#2852FC` | Primary — pin/anchor shape, primary buttons, headings |
| Bright blue | `#1D96FC` | Secondary — cursor shape, accents, links, gradient endpoint |

The logo uses a gradient between these two — safe to reuse that gradient direction (indigo → bright blue) for primary CTAs or score/status indicators in the Scan report UI.

## Voice

Grounded, literal, no jargon, no fluff. This applies to any customer-facing copy this codebase generates — scan report language, error messages, email/report templates.

- Lead with what the customer actually says, not the technical term. A business owner says "my phone stopped ringing," not "my machine-readability score dropped." Reports and UI copy should speak in the first register, even when the underlying check is technical.
- No abstract corporate language, no "unlock," "supercharge," "revolutionize." State what happened and what to do about it.
- Numbers over adjectives where possible — a score, a count, a before/after, not "significantly improved."
- This is the same register the Readable/Discoverable/Callable/Payable framing and the Scan/Fix/Monitor naming were already built around — nothing here requires changing copy already written, it's a confirmation of the direction, not a new direction.

## Explicitly not adopted here

An earlier brand-strategy pass (Alina Wheeler five-phase framework) proposed renaming the business (e.g., "Incoming," "Booked Solid," "Intercept") and referenced a different pricing structure ($299 audit / $499 / $999 monthly) than what's actually in use (Scan free/$30, Fix $300, Monitor $50/month — the complete offer ladder, no higher tier). That naming direction and pricing don't match the current business — not incorporated. The voice/tone guidance from that pass is the one piece that held up independent of the naming, and is reflected above.
