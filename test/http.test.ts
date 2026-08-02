// The ingest HTTP handler — routing, auth, and body handling — driven against a
// real ephemeral port. No Discord connection: the announce side effect is a spy.
import { test, expect, beforeAll, beforeEach, afterAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { AddressInfo } from "node:net";
import * as store from "../src/store";
import { createIngestListener } from "../src/http";
import type { MetricResult } from "../src/ingest";

const TZ = "America/Los_Angeles";
const TOKEN = "test-secret-123";

let server: http.Server;
let base: string;
let announced: MetricResult[][];

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acct-http-"));
  process.env.STEPS_GOAL = "10000";
  process.env.WATER_GOAL_GALLONS = "1";
  process.env.MEDITATION_MINUTES = "1";

  const listener = createIngestListener({
    token: TOKEN,
    tz: TZ,
    onResults: (r) => announced.push(r),
  });
  server = http.createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  store.save({ habits: {} });
  announced = [];
});

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

test("GET /healthz is public and returns ok", async () => {
  const res = await fetch(`${base}/healthz`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("requests without a valid token are rejected", async () => {
  expect((await fetch(`${base}/status`)).status).toBe(401);
  const bad = await fetch(`${base}/status`, { headers: { Authorization: "Bearer wrong" } });
  expect(bad.status).toBe(401);
});

test("POST /ingest checks off met goals and reports results", async () => {
  const res = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ steps: 10500, water: 1, meditation: 12 }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; results: MetricResult[] };
  expect(body.ok).toBe(true);
  expect(body.results.map((r) => r.habitId).sort()).toEqual(["meditate", "steps", "water"]);
  expect(body.results.every((r) => r.checkedOff)).toBe(true);

  // Persisted, and the injected announce callback saw the checked-off metrics.
  expect(store.load().habits["steps"].currentStreak).toBe(1);
  expect(announced).toHaveLength(1);
  expect(announced[0].every((r) => r.checkedOff)).toBe(true);
});

test("a second identical POST is idempotent (no new check-off)", async () => {
  const post = () =>
    fetch(`${base}/ingest`, { method: "POST", headers: auth, body: JSON.stringify({ steps: 10500 }) });
  await post();
  const res = await post();
  const body = (await res.json()) as { results: MetricResult[] };
  expect(body.results[0].checkedOff).toBe(false);
  expect(body.results[0].done).toBe(true);
  expect(store.load().habits["steps"].currentStreak).toBe(1);
});

test("GET /status returns today's progress", async () => {
  await fetch(`${base}/ingest`, { method: "POST", headers: auth, body: JSON.stringify({ steps: 10500 }) });
  const res = await fetch(`${base}/status`, { headers: auth });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { date: string; metrics: { metric: string; valueToday: number; done: boolean }[] };
  const steps = body.metrics.find((m) => m.metric === "steps")!;
  expect(steps.valueToday).toBe(10500);
  expect(steps.done).toBe(true);
});

test("invalid JSON is a 400, empty metrics is a 400", async () => {
  const badJson = await fetch(`${base}/ingest`, { method: "POST", headers: auth, body: "{not json" });
  expect(badJson.status).toBe(400);

  const empty = await fetch(`${base}/ingest`, { method: "POST", headers: auth, body: JSON.stringify({ junk: 1 }) });
  expect(empty.status).toBe(400);
});

test("unknown routes are 404", async () => {
  const res = await fetch(`${base}/nope`, { headers: auth });
  expect(res.status).toBe(404);
});
