import type { ScanResult, Tier } from "../types.ts";
import { renderText } from "./text.ts";
import { rankedGaps } from "./narrative.ts";

/**
 * Tier shaping. The free tier shows the four lines and the biggest problem. The
 * $29 tier unlocks the itemized gap report behind each score — same scan, more of
 * the result. We never run a lesser scan for the free tier; we just show less of it.
 */
export function shapeReport(result: ScanResult, tier: Tier): Record<string, unknown> {
  const summary = {
    requestedUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    scannedAt: result.scannedAt,
    scores: {
      readable: result.readable.score,
      discoverable: result.discoverable.score,
      callable: result.callable.score,
      payable: result.payable,
    },
    biggestProblem: result.biggestProblem,
    actions: result.actions,
  };

  if (tier === "free") {
    return {
      tier,
      ...summary,
      text: renderText(result, "free"),
      fullReportAvailable: true,
    };
  }

  return {
    tier,
    ...summary,
    durationMs: result.durationMs,
    userAgent: result.userAgent,
    detail: {
      readable: result.readable,
      discoverable: result.discoverable,
      callable: {
        ...result.callable,
        breaksAtStep: result.callable.breaksAt.step,
      },
      payable: {
        score: null,
        label: result.payable,
        note: "Not scored. Agent-payment standards are not settled, so there is nothing here we could measure honestly.",
      },
    },
    prioritizedGaps: rankedGaps([result.readable, result.discoverable, result.callable]).map((check) => ({
      id: check.id,
      label: check.label,
      pointsLost: check.possible - check.earned,
      status: check.status,
      finding: check.finding,
      recommendation: check.recommendation ?? null,
    })),
    pagesFetched: result.pagesFetched,
    limitations: result.limitations,
    text: renderText(result, "full"),
  };
}
