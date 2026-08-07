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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
