import { runScan, ScanError } from "./scan.ts";
import { renderText } from "./render/text.ts";
import { shapeReport } from "./render/report.ts";
import type { Tier } from "./types.ts";

/**
 * npm run scan -- https://example.com [--full] [--json]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args.find((arg) => !arg.startsWith("--"));
  const tier: Tier = args.includes("--full") ? "full" : "free";
  const asJson = args.includes("--json");

  if (!url) {
    console.error("Give me a URL to scan.\n\n  npm run scan -- https://example.com --full");
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runScan(url);
    console.log(asJson ? JSON.stringify(shapeReport(result, tier), null, 2) : renderText(result, tier));
  } catch (error) {
    if (error instanceof ScanError) {
      console.error(error.message);
      if (error.detail.recommendation) console.error(`\n${error.detail.recommendation}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

await main();
