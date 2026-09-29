// Roadmap 5D -- CORS policy + baseline API security headers
// (src/lib/httpSecurity.ts, wired in src/app.ts). DB-free: the real app is
// imported (so DATABASE_URL must be the placeholder -- see package.json), but
// every request here is answered before any route touches the database
// (health, preflights, and 401s for requests without a Bearer token).
//
//   DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:59999/placeholder \
//     tsx --test tests/httpSecurity.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, createServer, type Server, type IncomingHttpHeaders, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  API_SECURITY_HEADERS,
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  buildCorsOptions,
  createCorsMiddleware,
  parseAllowedOrigins,
} from "../src/lib/httpSecurity";

const PROD_ORIGIN = "https://channelsdruid.aiexperiments.eu";
const SECOND_ORIGIN = "https://second.example.test";
const EVIL_ORIGIN = "https://example.invalid";
const EXPECTED_METHODS = "GET,POST,PUT,PATCH,DELETE";
const EXPECTED_HEADERS = "Authorization,Content-Type,Accept";

type Reply = { status: number; headers: IncomingHttpHeaders };

// node:http rather than fetch so the browser-only Origin header can be set
// explicitly and nothing is added or stripped on our behalf.
function send(server: Server, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function listen(handler: RequestListener): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// A minimal app with only the CORS middleware, for the env matrix (the real
// app reads process.env once at import, so it can only represent one config).
async function withCorsApp(env: NodeJS.ProcessEnv, fn: (server: Server) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createCorsMiddleware(env));
  app.get("/ping", (_req, res) => {
    res.json({ ok: true });
  });
  const server = await listen(app);
  try {
    await fn(server);
  } finally {
    await close(server);
  }
}

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

test("parseAllowedOrigins: comma-separated, whitespace-trimmed, empties dropped", () => {
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(""), []);
  assert.deepEqual(parseAllowedOrigins("  ,  "), []);
  assert.deepEqual(parseAllowedOrigins(PROD_ORIGIN), [PROD_ORIGIN]);
  assert.deepEqual(parseAllowedOrigins(`  ${PROD_ORIGIN} ,${SECOND_ORIGIN}  ,`), [PROD_ORIGIN, SECOND_ORIGIN]);
});

test("buildCorsOptions: origin per environment/allowlist", () => {
  assert.equal(buildCorsOptions({ NODE_ENV: "development" }).origin, "*");
  assert.equal(buildCorsOptions({}).origin, "*");
  assert.deepEqual(buildCorsOptions({ NODE_ENV: "production" }).origin, []);
  assert.deepEqual(buildCorsOptions({ NODE_ENV: "production", CORS_ALLOWED_ORIGIN: " " }).origin, []);
  assert.deepEqual(buildCorsOptions({ NODE_ENV: "production", CORS_ALLOWED_ORIGIN: PROD_ORIGIN }).origin, [PROD_ORIGIN]);
  // A configured allowlist wins in development too.
  assert.deepEqual(buildCorsOptions({ NODE_ENV: "development", CORS_ALLOWED_ORIGIN: PROD_ORIGIN }).origin, [PROD_ORIGIN]);
});

test("buildCorsOptions: exact method + header allowlists, no credentials", () => {
  for (const env of [{}, { NODE_ENV: "production" }, { NODE_ENV: "production", CORS_ALLOWED_ORIGIN: PROD_ORIGIN }]) {
    const options = buildCorsOptions(env);
    assert.deepEqual(options.methods, ["GET", "POST", "PUT", "PATCH", "DELETE"]);
    assert.deepEqual(options.allowedHeaders, ["Authorization", "Content-Type", "Accept"]);
    assert.equal(options.credentials, false);
  }
  assert.deepEqual([...CORS_ALLOWED_METHODS], ["GET", "POST", "PUT", "PATCH", "DELETE"]);
  assert.deepEqual([...CORS_ALLOWED_HEADERS], ["Authorization", "Content-Type", "Accept"]);
});

// ---------------------------------------------------------------------------
// CORS behavior matrix (middleware only)
// ---------------------------------------------------------------------------

test("development + no allowlist: permissive", async () => {
  await withCorsApp({ NODE_ENV: "development" }, async (server) => {
    const res = await send(server, "GET", "/ping", { Origin: EVIL_ORIGIN });
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.equal(res.headers["access-control-allow-credentials"], undefined);
  });
});

test("production + no allowlist + browser Origin: no ACAO, request still served", async () => {
  await withCorsApp({ NODE_ENV: "production" }, async (server) => {
    const res = await send(server, "GET", "/ping", { Origin: PROD_ORIGIN });
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], undefined);

    const preflight = await send(server, "OPTIONS", "/ping", {
      Origin: PROD_ORIGIN,
      "Access-Control-Request-Method": "POST",
    });
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  });
});

test("one configured origin: match echoed, other origin gets no ACAO (not 401/403)", async () => {
  await withCorsApp({ NODE_ENV: "production", CORS_ALLOWED_ORIGIN: PROD_ORIGIN }, async (server) => {
    const ok = await send(server, "GET", "/ping", { Origin: PROD_ORIGIN });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["access-control-allow-origin"], PROD_ORIGIN);
    assert.match(String(ok.headers.vary), /Origin/);

    // Before 5D this returned ACAO: https://channelsdruid.aiexperiments.eu.
    const evil = await send(server, "GET", "/ping", { Origin: EVIL_ORIGIN });
    assert.equal(evil.status, 200);
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
  });
});

test("comma-separated origins with whitespace: each match echoed exactly", async () => {
  const env = { NODE_ENV: "production", CORS_ALLOWED_ORIGIN: ` ${PROD_ORIGIN} ,  ${SECOND_ORIGIN} ` };
  await withCorsApp(env, async (server) => {
    const first = await send(server, "GET", "/ping", { Origin: PROD_ORIGIN });
    assert.equal(first.headers["access-control-allow-origin"], PROD_ORIGIN);
    const second = await send(server, "GET", "/ping", { Origin: SECOND_ORIGIN });
    assert.equal(second.headers["access-control-allow-origin"], SECOND_ORIGIN);
    // Exact match only: no prefix/suffix/scheme leniency.
    for (const origin of [EVIL_ORIGIN, `${PROD_ORIGIN}.evil.test`, "http://channelsdruid.aiexperiments.eu"]) {
      const res = await send(server, "GET", "/ping", { Origin: origin });
      assert.equal(res.status, 200);
      assert.equal(res.headers["access-control-allow-origin"], undefined, origin);
    }
  });
});

test("request with no Origin works under every config", async () => {
  for (const env of [{}, { NODE_ENV: "production" }, { NODE_ENV: "production", CORS_ALLOWED_ORIGIN: PROD_ORIGIN }]) {
    await withCorsApp(env, async (server) => {
      const res = await send(server, "GET", "/ping");
      assert.equal(res.status, 200);
      assert.equal(res.headers["access-control-allow-credentials"], undefined);
    });
  }
});

// ---------------------------------------------------------------------------
// The real app (configured like production)
// ---------------------------------------------------------------------------

const ENV_KEYS = ["NODE_ENV", "CORS_ALLOWED_ORIGIN", "CHANNEL_CHIEF_API_TOKEN", "LOG_LEVEL"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let appServer: Server;

before(async () => {
  process.env.NODE_ENV = "production";
  process.env.CORS_ALLOWED_ORIGIN = PROD_ORIGIN;
  process.env.CHANNEL_CHIEF_API_TOKEN = "test-channel-chief-token-5d";
  process.env.LOG_LEVEL = "silent";
  // Imported only now: app.ts reads CORS_ALLOWED_ORIGIN at module load.
  const { default: app } = await import("../src/app");
  appServer = await listen(app);
});

after(async () => {
  if (appServer) await close(appServer);
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function assertApiSecurityHeaders(res: Reply): void {
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
  assert.equal(res.headers["x-powered-by"], undefined);
  assert.equal(Object.keys(API_SECURITY_HEADERS).length, 4);
}

test("app: /api/healthz carries API security headers, no X-Powered-By", async () => {
  const res = await send(appServer, "GET", "/api/healthz");
  assert.equal(res.status, 200);
  assertApiSecurityHeaders(res);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("app: OPTIONS preflight from allowed origin -> 204 + exact CORS headers", async () => {
  const res = await send(appServer, "OPTIONS", "/api/users/123", {
    Origin: PROD_ORIGIN,
    "Access-Control-Request-Method": "PATCH",
    "Access-Control-Request-Headers": "authorization,content-type",
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers["access-control-allow-origin"], PROD_ORIGIN);
  assert.equal(res.headers["access-control-allow-methods"], EXPECTED_METHODS);
  assert.equal(res.headers["access-control-allow-headers"], EXPECTED_HEADERS);
  assert.equal(res.headers["access-control-allow-credentials"], undefined);
  assertApiSecurityHeaders(res);
});

test("app: OPTIONS preflight from disallowed origin -> no ACAO, not 401/403", async () => {
  const res = await send(appServer, "OPTIONS", "/api/users/123", {
    Origin: EVIL_ORIGIN,
    "Access-Control-Request-Method": "PATCH",
    "Access-Control-Request-Headers": "authorization",
  });
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
});

test("app: unauthenticated human PPTX export -> 401 with security headers", async () => {
  const res = await send(appServer, "GET", "/api/exports/quarterly-pptx", { Origin: PROD_ORIGIN });
  assert.equal(res.status, 401);
  assertApiSecurityHeaders(res);
  assert.equal(res.headers["access-control-allow-origin"], PROD_ORIGIN);
});

test("app: unauthenticated Channel Chief (no Origin, server-to-server) -> 401 with security headers", async () => {
  const res = await send(appServer, "GET", "/api/channel-chief/snapshot");
  assert.equal(res.status, 401);
  assertApiSecurityHeaders(res);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});
