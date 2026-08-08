import app from "./app";
import { logger } from "./lib/logger";
import { ensureConnectionsSeeded } from "./services/connections";
import { ensureMetricMappingsSeeded } from "./services/kpiService";
import { runWeeklySnapshotWriter } from "./services/snapshotWriter";

await Promise.all([ensureConnectionsSeeded(), ensureMetricMappingsSeeded()]).catch((err) => {
  logger.error({ err }, "Failed to seed connections/metric mappings");
});

const SNAPSHOT_WRITER_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Fire-and-forget by design: the snapshot writer must never block or fail
// server startup, and each run (initial or recurring) is caught and logged
// independently so one bad run never stops future ones. index.ts is this
// process's single entrypoint module -- Node's ES module cache guarantees
// it only executes once per process, so there's no risk of this setInterval
// being registered twice.
function runSnapshotWriterSafely(): void {
  runWeeklySnapshotWriter().catch((err) => {
    logger.error({ err }, "Weekly KPI snapshot writer run failed");
  });
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Only start once the server is actually listening -- no snapshot DB
  // work happens if port validation or server binding failed above.
  runSnapshotWriterSafely();
  setInterval(runSnapshotWriterSafely, SNAPSHOT_WRITER_INTERVAL_MS).unref();
});
