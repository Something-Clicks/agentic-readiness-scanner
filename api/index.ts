import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "../src/http/server.ts";

/**
 * Serverless entry point.
 *
 * Vercel does not run a long-lived process, so nothing here calls listen(). It
 * invokes an exported handler once per request instead — and an Express app is
 * already a (req, res) function, so the same app that serves `npm run dev` serves
 * here without a second copy of the routing.
 *
 * The app is built once at module scope so a warm invocation reuses it. Anything
 * expensive that happened per-request would be paid on every scan.
 *
 * src/index.ts stays as it is: that is the local server, and it is the file that
 * calls listen(). Only files in api/ become functions.
 */
const app = createServer();

/** Vercel's rewrite may deliver the original path or the /api one. Accept both. */
const API_PREFIX = /^\/api(?=[/?]|$)/;

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.url) {
    const normalized = req.url.replace(API_PREFIX, "");
    req.url = normalized === "" ? "/" : normalized;
  }
  (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
}
