/**
 * Shared types for the Phase 1 (Diagnostic) scan.
 *
 * Vocabulary note: Readable / Discoverable / Callable / Payable are the diagnostic
 * concepts the report is built around. Scan / Fix / Monitor are the product names.
 * Phase 1 implements Scan only.
 */

/** How much a single check contributed, and why. */
export interface CheckResult {
  /** Stable machine id, e.g. "readable.localbusiness_schema". */
  id: string;
  /** Short human label used in the itemized report. */
  label: string;
  /** Points earned by this check. */
  earned: number;
  /** Points this check was worth. */
  possible: number;
  /** Pass / partial / fail, derived from earned vs possible. */
  status: CheckStatus;
  /** Plain-language statement of what we found. Brand voice: literal, no jargon. */
  finding: string;
  /** Plain-language statement of what to do about it. Omitted when nothing to do. */
  recommendation?: string;
  /** Raw supporting detail — the evidence behind the finding. */
  evidence?: Record<string, unknown>;
}

export type CheckStatus = "pass" | "partial" | "fail";

/** A scored pillar: Readable, Discoverable, or Callable. */
export interface PillarResult {
  name: "READABLE" | "DISCOVERABLE" | "CALLABLE";
  score: number;
  checks: CheckResult[];
  /** Deductions applied on top of the check total (e.g. JS-render dependency). */
  penalties: Penalty[];
}

export interface Penalty {
  id: string;
  label: string;
  points: number;
  finding: string;
  recommendation?: string;
}

/** One step of the Callable task-path trace. Each step is worth 0–20. */
export interface TaskPathStep extends CheckResult {
  /** 1–5, the position in the task path. */
  step: number;
}

export interface CallableResult extends PillarResult {
  name: "CALLABLE";
  steps: TaskPathStep[];
  /** The step the path breaks at — lowest scoring, earliest on tie. */
  breaksAt: TaskPathStep;
}

export interface ScanResult {
  /** URL as supplied by the caller. */
  requestedUrl: string;
  /** URL actually scanned after normalization and redirects. */
  finalUrl: string;
  scannedAt: string;
  /** Wall-clock duration of the whole scan, in milliseconds. */
  durationMs: number;
  /** The user agent every request in this scan was sent with. */
  userAgent: string;
  readable: PillarResult;
  discoverable: PillarResult;
  callable: CallableResult;
  /** Never scored. Always the literal string "— roadmap". */
  payable: "— roadmap";
  biggestProblem: string;
  actions: string[];
  /** Pages fetched during the scan, with status and timing. */
  pagesFetched: PageSummary[];
  /** Things we could not check, and why. Honest gaps, not silent omissions. */
  limitations: string[];
}

export interface PageSummary {
  url: string;
  role: PageRole;
  status: number | null;
  elapsedMs: number;
  /** Set when the fetch failed outright. */
  error?: string;
  /** Set when the response looks like a block rather than the real page. */
  blockSignal?: string;
}

export type PageRole = "homepage" | "services" | "contact" | "booking" | "about" | "other";

export type Tier = "free" | "full";
