# agentic-readiness-scanner

Scan, Fix, and Monitor local business websites for AI agent readability, discoverability, and callable actions.

Something Clicks helps local businesses become understandable, discoverable, and transactable by the machines now deciding which local businesses get found — search crawlers, AI systems (Google AI Overviews, ChatGPT, Claude, Perplexity), and the autonomous agents starting to browse, book, and buy on a person's behalf.

## Products

- **Scan** — diagnoses whether AI agents can find, understand, and act on a business website. Scores Readable / Discoverable / Callable; reports Payable as roadmap.
- **Fix** — implements the corrections Scan identifies, within a fixed, standardized scope. See `docs/build-spec.md` for the exact scope boundaries and fixability classification.
- **Monitor** — continuously checks for changes that affect machine readability, discoverability, or actionability.

## Status

Phase 1 (Scan / Diagnostic) is the current build target. Fix and Monitor come after Phase 1 is validated against real businesses.

## Docs

- [`docs/build-spec.md`](docs/build-spec.md) — full technical implementation spec, phase by phase. This is the source of truth for what to build — read it before writing code.

## Getting started

_(Fill in once the stack is chosen and the project scaffolding exists — e.g. install steps, how to run a scan locally, required env vars.)_

## Product integrity constraints (apply everywhere in this codebase)

- Always fetch with an honest, disclosed user agent. Never impersonate Googlebot or another platform's crawler.
- Never claim the product can negotiate with, talk directly to, or guarantee action from a specific AI agent.
- Score and report only what's actually verifiable. The Payable line is always labeled as roadmap, never scored.
