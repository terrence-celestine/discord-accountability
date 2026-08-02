// http.ts — the Samsung Health ingest request handler, factored out of index.ts
// so it can be unit-tested against a real port without a Discord connection.
//
// It owns routing, bearer-token auth, and body parsing; the actual side effect of
// a completed metric (posting to Discord) is injected via `onResults`, keeping this
// module free of any discord.js dependency.

import http from "node:http";
import crypto from "node:crypto";
import * as ingest from "./ingest";

export interface IngestServerOptions {
  token: string; // shared secret required on /ingest and /status
  tz: string;
  onResults?: (results: ingest.MetricResult[]) => void; // e.g. announce check-offs in Discord
}

// Constant-time `Authorization: Bearer <token>` comparison.
const authorized = (req: http.IncomingMessage, token: string): boolean => {
  const raw = req.headers["authorization"];
  const header = Array.isArray(raw) ? raw[0] : raw ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const provided = Buffer.from(m[1]);
  const expected = Buffer.from(token);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
};

const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

// Read the full request body as a string, rejecting anything oversized.
const readBody = (req: http.IncomingMessage, limit = 1_000_000): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const route = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: IngestServerOptions,
): Promise<void> => {
  const path = (req.url ?? "/").split("?")[0];

  // Unauthenticated liveness probe for the platform (Railway health check).
  if (req.method === "GET" && path === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (!authorized(req, opts.token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && path === "/status") {
    sendJson(res, 200, ingest.buildTodayStatus(opts.tz));
    return;
  }

  if (req.method === "POST" && path === "/ingest") {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 413, { error: "payload too large" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: "invalid JSON" });
      return;
    }
    const values = ingest.parsePayload(parsed);
    if (ingest.isEmpty(values)) {
      sendJson(res, 400, { error: "no valid metrics — expected any of steps, water, meditation" });
      return;
    }
    const results = ingest.handleIngest(values, opts.tz);
    opts.onResults?.(results); // side effect (Discord announce); handler itself stays pure
    sendJson(res, 200, { ok: true, results });
    return;
  }

  sendJson(res, 404, { error: "not found" });
};

// Build the http.RequestListener for the ingest endpoints.
export const createIngestListener = (opts: IngestServerOptions): http.RequestListener => {
  return (req, res) => {
    route(req, res, opts).catch((err) => {
      console.error("Ingest request failed:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  };
};
