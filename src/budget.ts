import { config } from "./config.ts";

/**
 * A wall-clock budget for one scan.
 *
 * Phase 1 scans run synchronously inside a single request, so the scan's duration
 * is the response's duration. Without a ceiling, one unresponsive site can hold a
 * request open for minutes: the scan makes up to ten sequential fetches, and a
 * stalled site pays the full per-fetch timeout on every one of them.
 *
 * The budget makes that bounded and honest. Every fetch is capped at whatever time
 * is actually left, and work we run out of time for is recorded as skipped rather
 * than silently dropped — a check we could not run must never read as a check that
 * passed.
 */
export class ScanBudget {
  private readonly deadline: number;
  private readonly perFetchMs: number;
  private readonly skipped: SkippedWork[] = [];

  constructor(totalMs: number = config.scanTimeoutMs, perFetchMs: number = config.fetchTimeoutMs) {
    this.deadline = Date.now() + totalMs;
    this.perFetchMs = perFetchMs;
    this.totalMs = totalMs;
  }

  readonly totalMs: number;

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  /**
   * True once there is too little time left to be worth starting another fetch.
   * The floor stops us opening a connection we know we cannot wait out.
   */
  isExhausted(): boolean {
    return this.remainingMs() <= MINIMUM_USEFUL_FETCH_MS;
  }

  /** Timeout for a single fetch: the per-fetch cap, or whatever is left if that is less. */
  timeoutForFetch(): number {
    return Math.max(MINIMUM_USEFUL_FETCH_MS, Math.min(this.perFetchMs, this.remainingMs()));
  }

  /** Record work the scan did not get to, so the report can say so plainly. */
  skip(work: SkippedWork): void {
    this.skipped.push(work);
  }

  skippedWork(): readonly SkippedWork[] {
    return this.skipped;
  }

  ranOutOfTime(): boolean {
    return this.skipped.some((work) => work.reason === "out-of-time");
  }
}

export interface SkippedWork {
  /** What we did not do, in plain language. */
  what: string;
  reason: "out-of-time" | "candidate-limit";
}

/** Below this there is no point starting a request; it cannot finish. */
const MINIMUM_USEFUL_FETCH_MS = 250;
