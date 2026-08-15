// Phase 8: structural test for the management PPT deck (managementReportPptx.ts).
// Calls buildManagementReportPptx() directly against a live (disposable)
// Postgres -- same DB dependency as getManagementReportSummary() itself, so
// this cannot be a pure/DB-free test.
//
//   DATABASE_URL=... tsx --test tests/managementReportPptx.test.ts
//
// WRITTEN BUT NOT RUN in this session: no disposable Postgres was available
// or permitted (Phase 8 working rules forbid Docker/production DB access).
// No live provider calls are made: currency is fixed to "USD" for every
// case, which resolveFx short-circuits without a Frankfurter call.
//
// This is a structural test only (valid, non-trivial PPTX bytes), matching
// the existing quarterly deck's own test depth (tests/roleSeparation.test.ts
// checks only HTTP status/content-type for GET /exports/quarterly-pptx, no
// slide content) -- content-level assertions would require unzipping/
// parsing the OOXML package, which no test in this codebase does today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { buildManagementReportPptx } from "../src/services/managementReportPptx";

test("buildManagementReportPptx produces a non-empty, well-formed PPTX (OOXML zip) buffer for the Global scope", async () => {
  const [headOfChannels] = await db.select().from(usersTable).where(eq(usersTable.role, "head_of_channels")).limit(1);
  assert.ok(headOfChannels, "expected at least one seeded head_of_channels user");

  const buffer = await buildManagementReportPptx(headOfChannels!, {
    weekStart: null,
    target: { territoryId: null, territoryName: "Global" },
    currency: "USD",
  });

  assert.ok(buffer.length > 10_000, `expected a non-trivial PPTX file, got ${buffer.length} bytes`);
  // OOXML/zip magic bytes ("PK\x03\x04") -- proves pptxgenjs actually
  // produced a real archive, not an empty/corrupt buffer.
  assert.equal(buffer[0], 0x50);
  assert.equal(buffer[1], 0x4b);
});

test("buildManagementReportPptx accepts an explicit historical canonical-Monday week_start without throwing", async () => {
  const [headOfChannels] = await db.select().from(usersTable).where(eq(usersTable.role, "head_of_channels")).limit(1);
  assert.ok(headOfChannels);

  const buffer = await buildManagementReportPptx(headOfChannels!, {
    weekStart: "2025-01-06", // a real canonical Monday, far in the past
    target: { territoryId: null, territoryName: "Global" },
    currency: "USD",
  });

  assert.ok(buffer.length > 10_000);
});

test("buildManagementReportPptx rejects a non-canonical-Monday week_start (surfaces the same WeeklyReportValidationError getManagementReportSummary throws)", async () => {
  const [headOfChannels] = await db.select().from(usersTable).where(eq(usersTable.role, "head_of_channels")).limit(1);
  assert.ok(headOfChannels);

  await assert.rejects(() =>
    buildManagementReportPptx(headOfChannels!, {
      weekStart: "2026-07-14", // a Tuesday
      target: { territoryId: null, territoryName: "Global" },
      currency: "USD",
    }),
  );
});
