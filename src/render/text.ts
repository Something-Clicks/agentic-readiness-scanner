import type { CheckResult, PillarResult, ScanResult, Tier } from "../types.ts";

/**
 * The plain-text report. The free-tier block is byte-for-byte the layout in
 * build-spec.md's Phase 1 section — do not restyle it without changing the spec.
 * The $30 tier appends the itemized gap report behind each score.
 */

const LABEL_WIDTH = 15;
const SUMMARY_WRAP = 55;
const DETAIL_WRAP = 72;

export function renderText(result: ScanResult, tier: Tier): string {
  const sections = [renderSummary(result)];
  if (tier === "full") sections.push(renderFullReport(result));
  return sections.join("\n\n");
}

function renderSummary(result: ScanResult): string {
  const lines: string[] = [
    "SOMETHING CLICKS — AGENTIC READINESS",
    "",
    `${"READABLE".padEnd(LABEL_WIDTH)}${result.readable.score}/100`,
    `${"DISCOVERABLE".padEnd(LABEL_WIDTH)}${result.discoverable.score}/100`,
    `${"CALLABLE".padEnd(LABEL_WIDTH)}${result.callable.score}/100`,
    // Never scored. Phase 4 is roadmap only, and the label says so in every report.
    `${"PAYABLE".padEnd(LABEL_WIDTH)}${result.payable}`,
    "",
    "BIGGEST PROBLEM",
    ...wrapPreservingBreaks(result.biggestProblem, SUMMARY_WRAP),
    "",
    "ACTIONS",
    ...(result.actions.length > 0
      ? result.actions.map((action, index) => `${index + 1}. ${action}`)
      : // A site with nothing left to fix gets told so, plainly.
        wrap("Nothing to fix on the checks this scan covers.", SUMMARY_WRAP)),
  ];
  return lines.join("\n");
}

function renderFullReport(result: ScanResult): string {
  const lines: string[] = [
    rule(),
    "FULL REPORT",
    "",
    `Scanned      ${result.finalUrl}`,
    `At           ${result.scannedAt}`,
    `Took         ${(result.durationMs / 1000).toFixed(1)}s`,
    `User agent   ${result.userAgent}`,
    "",
    "PAGES READ",
    ...result.pagesFetched.map((page) => {
      const status = page.error ? page.error : `HTTP ${page.status}`;
      const block = page.blockSignal ? ` — ${page.blockSignal}` : "";
      return `  ${page.role.padEnd(10)} ${page.url}\n  ${" ".repeat(10)} ${status}, ${page.elapsedMs}ms${block}`;
    }),
    "",
    ...renderPillar(result.readable),
    "",
    ...renderCallable(result),
    "",
    ...renderPillar(result.discoverable),
    "",
    rule(),
    `PAYABLE        ${result.payable}`,
    ...wrap(
      "Payable is not scored. Agent-payment standards are not settled yet, so there is nothing here we could measure honestly. The label stays on every report until that changes.",
      DETAIL_WRAP,
    ).map((line) => `  ${line}`),
    "",
    "WHAT THIS SCAN DID NOT COVER",
    ...result.limitations.flatMap((limitation) => wrap(`- ${limitation}`, DETAIL_WRAP).map((line, index) => (index === 0 ? line : `  ${line}`))),
  ];
  return lines.join("\n");
}

function renderPillar(pillar: PillarResult): string[] {
  const scored = pillar.checks.filter((check) => check.possible > 0);
  const notScored = pillar.checks.filter((check) => check.possible === 0);

  const lines: string[] = [rule(), `${pillar.name}   ${pillar.score}/100`, ""];

  for (const check of scored) {
    lines.push(...renderCheck(check));
  }
  for (const penalty of pillar.penalties) {
    lines.push(`  [-${penalty.points}]  ${penalty.label}`);
    lines.push(...wrap(penalty.finding, DETAIL_WRAP).map((line) => `        ${line}`));
    if (penalty.recommendation) {
      lines.push(...wrap(`Do this: ${penalty.recommendation}`, DETAIL_WRAP).map((line) => `        ${line}`));
    }
    lines.push("");
  }
  for (const check of notScored) {
    lines.push(`  [note] ${check.label}`);
    lines.push(...wrap(check.finding, DETAIL_WRAP).map((line) => `        ${line}`));
    if (check.recommendation) {
      lines.push(...wrap(`Do this: ${check.recommendation}`, DETAIL_WRAP).map((line) => `        ${line}`));
    }
    lines.push("");
  }

  return trimTrailingBlank(lines);
}

function renderCallable(result: ScanResult): string[] {
  const lines: string[] = [
    rule(),
    `CALLABLE   ${result.callable.score}/100`,
    "",
    "  The task path an agent walks to actually hire this business.",
    result.callable.breaksAt.earned < 18
      ? `  It breaks at step ${result.callable.breaksAt.step}: ${result.callable.breaksAt.label}.`
      : "  It holds up end to end — an agent can get from services to booked.",
    "",
  ];

  for (const step of result.callable.steps) {
    lines.push(`  ${step.earned}/${step.possible}  Step ${step.step} — ${step.label}  [${step.status}]`);
    lines.push(...wrap(step.finding, DETAIL_WRAP).map((line) => `        ${line}`));
    if (step.recommendation) {
      lines.push(...wrap(`Do this: ${step.recommendation}`, DETAIL_WRAP).map((line) => `        ${line}`));
    }
    lines.push("");
  }

  return trimTrailingBlank(lines);
}

function renderCheck(check: CheckResult): string[] {
  const lines = [`  ${check.earned}/${check.possible}  ${check.label}  [${check.status}]`];
  lines.push(...wrap(check.finding, DETAIL_WRAP).map((line) => `        ${line}`));
  if (check.recommendation) {
    lines.push(...wrap(`Do this: ${check.recommendation}`, DETAIL_WRAP).map((line) => `        ${line}`));
  }
  lines.push("");
  return lines;
}

function rule(): string {
  return "─".repeat(76);
}

function trimTrailingBlank(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop();
  return copy;
}

/** Keep any line breaks the copy already chose, and wrap what is left. */
function wrapPreservingBreaks(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => wrap(line, width));
}

export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
