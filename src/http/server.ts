import express from "express";
import type { Request, Response } from "express";
import { config } from "../config.ts";
import { runScan, ScanError } from "../scan.ts";
import { shapeReport } from "../render/report.ts";
import { renderText } from "../render/text.ts";
import type { Tier } from "../types.ts";

export function createServer() {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.disable("x-powered-by");

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, userAgent: config.userAgent });
  });

  app.get("/scan", (req, res) => handleScan(req, res, String(req.query.url ?? "")));
  app.post("/scan", (req, res) => handleScan(req, res, String((req.body as { url?: unknown })?.url ?? "")));

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: `There is nothing at ${req.path}.`,
      recommendation: "Use GET /scan?url=… or POST /scan with a JSON body of {\"url\": \"…\"}.",
    });
  });

  return app;
}

async function handleScan(req: Request, res: Response, url: string): Promise<void> {
  const tier = readTier(req);
  const format = readFormat(req);

  if (!url.trim()) {
    respondError(res, 400, {
      error: "No web address was given.",
      recommendation: "Add ?url=https://example.com to the request.",
    }, format);
    return;
  }

  try {
    const result = await runScan(url);
    if (format === "text") {
      res.type("text/plain; charset=utf-8").send(renderText(result, tier));
      return;
    }
    res.json(shapeReport(result, tier));
  } catch (error) {
    if (error instanceof ScanError) {
      // A site we cannot read is a finding about the site, not a server fault.
      respondError(res, 422, {
        error: error.message,
        recommendation: error.detail.recommendation,
        url: error.detail.url,
        status: error.detail.status ?? null,
      }, format);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    respondError(res, 500, {
      error: "The scan stopped partway through and we did not get a result.",
      detail: message,
      recommendation: "Try again. If it keeps happening, send us the URL you scanned.",
    }, format);
  }
}

function respondError(res: Response, status: number, body: Record<string, unknown>, format: "json" | "text"): void {
  if (format === "text") {
    const lines = [String(body.error)];
    if (body.recommendation) lines.push("", String(body.recommendation));
    res.status(status).type("text/plain; charset=utf-8").send(lines.join("\n"));
    return;
  }
  res.status(status).json(body);
}

function readTier(req: Request): Tier {
  const raw = String(req.query.tier ?? (req.body as { tier?: unknown })?.tier ?? "free").toLowerCase();
  return raw === "full" || raw === "paid" || raw === "30" ? "full" : "free";
}

function readFormat(req: Request): "json" | "text" {
  const raw = String(req.query.format ?? (req.body as { format?: unknown })?.format ?? "").toLowerCase();
  if (raw === "text" || raw === "txt") return "text";
  if (raw === "json") return "json";
  return req.accepts(["json", "text"]) === "text" ? "text" : "json";
}
