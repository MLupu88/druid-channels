import express, { type Express } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { apiSecurityHeaders, createCorsMiddleware } from "./lib/httpSecurity";

const app: Express = express();
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(apiSecurityHeaders);
// CORS_ALLOWED_ORIGIN is a comma-separated origin allowlist. Unset in
// production, no browser origin is granted cross-origin access; unset in
// development, it stays permissive. See lib/httpSecurity.ts.
app.use(createCorsMiddleware(process.env));
// Stage 6 Portfolio import batches are client-parsed Excel/CSV rows sent as
// one JSON body (no multipart/multer in this app) -- a book of a few
// hundred rows comfortably exceeds express.json()'s default 100kb limit.
// This MUST be mounted before the global express.json() below: once the
// global (small-limit) parser has already rejected an oversized body with
// 413, a later route-scoped parser never gets a chance to run. Once this
// one successfully parses the body, body-parser's own req._body flag makes
// the global parser below a no-op for this path -- every other route keeps
// the default small limit unchanged.
app.use("/api/portfolio/imports", express.json({ limit: "5mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
