import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
// CORS_ALLOWED_ORIGIN locks the API to a single origin in production. Left
// unset, cors() falls back to its permissive default so local development
// (frontend and API on different dev-server ports/origins) keeps working
// exactly as before.
const corsAllowedOrigin = process.env.CORS_ALLOWED_ORIGIN;
app.use(cors(corsAllowedOrigin ? { origin: corsAllowedOrigin } : undefined));
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
