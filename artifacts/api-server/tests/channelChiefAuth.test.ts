// Pure unit tests for the Aniri/Channel Chief machine-to-machine auth
// middleware (middleware/channelChiefAuth.ts). No live DB, no live server --
// this module touches neither, so these tests exercise the handler directly
// against fake req/res objects, same spirit as pamCopilot.test.ts's
// no-live-server pure-unit checks.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Request, Response } from "express";
import { requireChannelChiefToken } from "../src/middleware/channelChiefAuth";

const ORIGINAL_TOKEN = process.env.CHANNEL_CHIEF_API_TOKEN;
const TEST_TOKEN = "test-channel-chief-token-89af";

after(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.CHANNEL_CHIEF_API_TOKEN;
  else process.env.CHANNEL_CHIEF_API_TOKEN = ORIGINAL_TOKEN;
});

function fakeRes() {
  const res = {
    statusCode: null as number | null,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res as unknown as Response;
    },
    json(payload: unknown) {
      res.body = payload;
      return res as unknown as Response;
    },
  };
  return res;
}

function fakeReq(overrides: { authorization?: string; query?: Record<string, unknown> } = {}) {
  return {
    headers: overrides.authorization ? { authorization: overrides.authorization } : {},
    query: overrides.query ?? {},
  } as unknown as Request;
}

function invoke(req: Request, res: ReturnType<typeof fakeRes>) {
  let nextCalled = false;
  requireChannelChiefToken(req, res as unknown as Response, (() => {
    nextCalled = true;
  }) as never);
  return nextCalled;
}

test("requireChannelChiefToken: fails closed when CHANNEL_CHIEF_API_TOKEN is not configured, even with a token supplied", () => {
  delete process.env.CHANNEL_CHIEF_API_TOKEN;
  const res = fakeRes();
  const nextCalled = invoke(fakeReq({ authorization: "Bearer anything" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("requireChannelChiefToken: missing Authorization header is rejected (401)", () => {
  process.env.CHANNEL_CHIEF_API_TOKEN = TEST_TOKEN;
  const res = fakeRes();
  const nextCalled = invoke(fakeReq(), res);
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("requireChannelChiefToken: wrong token is rejected (401)", () => {
  process.env.CHANNEL_CHIEF_API_TOKEN = TEST_TOKEN;
  const res = fakeRes();
  const nextCalled = invoke(fakeReq({ authorization: "Bearer wrong-token" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("requireChannelChiefToken: correct Bearer token is allowed, and never populates actingUser", () => {
  process.env.CHANNEL_CHIEF_API_TOKEN = TEST_TOKEN;
  const req = fakeReq({ authorization: `Bearer ${TEST_TOKEN}` });
  const res = fakeRes();
  const nextCalled = invoke(req, res);
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.equal((req as unknown as { actingUser?: unknown }).actingUser, undefined);
});

test("requireChannelChiefToken: the real token passed only as a query string parameter is NOT accepted", () => {
  process.env.CHANNEL_CHIEF_API_TOKEN = TEST_TOKEN;
  const res = fakeRes();
  const nextCalled = invoke(fakeReq({ query: { token: TEST_TOKEN } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("requireChannelChiefToken: a case-insensitive 'bearer' prefix is still accepted", () => {
  process.env.CHANNEL_CHIEF_API_TOKEN = TEST_TOKEN;
  const nextCalled = invoke(fakeReq({ authorization: `bearer ${TEST_TOKEN}` }), fakeRes());
  assert.equal(nextCalled, true);
});

// ---- structural guard: this boundary must never call an LLM/provider ------

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const AI_PROVIDER_PATTERN = /copilotProvider|aiBriefProvider|discoveryProviders\/ai|channelRadarProviders\/ai/;

test("services/channelChiefContextService.ts never imports a DeepSeek/AI provider module (no LLM call involved)", () => {
  const source = readFileSync(path.join(SRC_DIR, "services/channelChiefContextService.ts"), "utf8");
  assert.ok(!AI_PROVIDER_PATTERN.test(source), "Channel Chief's data boundary must never call an AI provider -- interpretation happens on Aniri's side.");
});

test("routes/channel_chief.ts never imports a DeepSeek/AI provider module (no LLM call involved)", () => {
  const source = readFileSync(path.join(SRC_DIR, "routes/channel_chief.ts"), "utf8");
  assert.ok(!AI_PROVIDER_PATTERN.test(source), "The Channel Chief route must never call an AI provider directly.");
});
