import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { usersTable, territoriesTable } from "@workspace/db";
import { hashPassword } from "../services/password";

// Idempotent bootstrap seed for the DRUID Channels & Alliances team.
//
// Safe to re-run against an already-seeded database:
// - Users that already exist (matched by unique email) are never touched --
//   no password reset, no role/territory/active/name overwrite.
// - A SEED_PASSWORD_* env var is required ONLY for a user that does not yet
//   exist in the database. Once all six accounts exist, bootstrap passwords
//   can be removed from the environment entirely.
// - A territory's owner_user_id is only ever set when it is still null --
//   an existing owner assignment is never overwritten.
//
// Run (only the users missing from the DB need a password set):
//   SEED_PASSWORD_IRINA=... SEED_PASSWORD_DENNY=... SEED_PASSWORD_JAMES=... \
//   SEED_PASSWORD_CHASE=... SEED_PASSWORD_VLAD=... SEED_PASSWORD_ELENA=... \
//   pnpm --filter @workspace/api-server run seed

interface SeedUser {
  name: string;
  email: string;
  role: "head_of_channels" | "pam" | "admin";
  territory: string | null;
  passwordEnvVar: string;
}

const MIN_PASSWORD_LENGTH = 16;

const TERRITORIES = [
  "UK & Ireland",
  "Portugal, Canada and South America",
  "Central and Eastern Europe",
  "DACH",
  "United States",
] as const;

const USERS: SeedUser[] = [
  { name: "Irina Dochitu", email: "irina.dochitu@druidai.com", role: "head_of_channels", territory: null, passwordEnvVar: "SEED_PASSWORD_IRINA" },
  { name: "Denny Morais", email: "denny.morais@druidai.com", role: "pam", territory: "Portugal, Canada and South America", passwordEnvVar: "SEED_PASSWORD_DENNY" },
  { name: "James Bradley", email: "james.bradley@druidai.com", role: "pam", territory: "UK & Ireland", passwordEnvVar: "SEED_PASSWORD_JAMES" },
  { name: "Chase Baylor", email: "chase.baylor@druidai.com", role: "pam", territory: "United States", passwordEnvVar: "SEED_PASSWORD_CHASE" },
  { name: "Vlad Greavu", email: "vlad.greavu@druidai.com", role: "pam", territory: "DACH", passwordEnvVar: "SEED_PASSWORD_VLAD" },
  { name: "Elena Panait", email: "elena.panait@druidai.com", role: "pam", territory: "Central and Eastern Europe", passwordEnvVar: "SEED_PASSWORD_ELENA" },
];

async function loadExistingSeedUsers(): Promise<Map<string, typeof usersTable.$inferSelect>> {
  const rows = await db
    .select()
    .from(usersTable)
    .where(inArray(usersTable.email, USERS.map((u) => u.email)));
  return new Map(rows.map((r) => [r.email, r]));
}

// Every seeded identity's role must match what this seed expects for it,
// checked for ALL six emails up front (not just PAMs) before anything is
// written. A drifted role (Irina no longer head_of_channels, or a PAM
// promoted/demoted/repurposed outside this seed) means the account and this
// seed disagree about identity -- fail loudly and make no changes rather
// than silently proceeding or auto-correcting the role.
function validateExistingSeedRoles(existing: Map<string, typeof usersTable.$inferSelect>): void {
  const mismatches: string[] = [];
  for (const user of USERS) {
    const found = existing.get(user.email);
    if (!found) continue; // not yet created -- nothing to validate
    if (found.role !== user.role) {
      mismatches.push(`${user.email}: expected role "${user.role}", found "${found.role}"`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Existing seeded user(s) have an unexpected role -- refusing to make any changes. ${mismatches.join("; ")}. ` +
        `Resolve manually (this script never overwrites a role automatically).`,
    );
  }
}

// Only users NOT already in the database require a password env var.
function readRequiredPasswords(missingUsers: SeedUser[]): Map<string, string> {
  const missingEnvVars: string[] = [];
  const passwords = new Map<string, string>();

  for (const user of missingUsers) {
    const value = process.env[user.passwordEnvVar];
    if (!value || value.trim() === "") {
      missingEnvVars.push(user.passwordEnvVar);
    } else {
      passwords.set(user.email, value);
    }
  }

  if (missingEnvVars.length > 0) {
    throw new Error(
      `Missing required seed password environment variable(s) for user(s) not yet in the database: ` +
        `${missingEnvVars.join(", ")}. Already-seeded users do not require a password env var.`,
    );
  }

  return passwords;
}

// Enforce minimum length and per-run uniqueness for passwords about to be
// hashed and stored. Runs before any DB write. Never logs a password value.
function validateNewPasswords(missingUsers: SeedUser[], passwords: Map<string, string>): void {
  const tooShort = missingUsers
    .filter((u) => passwords.get(u.email)!.length < MIN_PASSWORD_LENGTH)
    .map((u) => u.passwordEnvVar);
  if (tooShort.length > 0) {
    throw new Error(
      `Seed password(s) shorter than ${MIN_PASSWORD_LENGTH} characters: ${tooShort.join(", ")}.`,
    );
  }

  const firstUseByValue = new Map<string, string>(); // password value -> first env var seen
  const duplicates: string[] = [];
  for (const user of missingUsers) {
    const value = passwords.get(user.email)!;
    const firstEnvVar = firstUseByValue.get(value);
    if (firstEnvVar) {
      duplicates.push(`${firstEnvVar} / ${user.passwordEnvVar}`);
    } else {
      firstUseByValue.set(value, user.passwordEnvVar);
    }
  }
  if (duplicates.length > 0) {
    throw new Error(`Seed passwords must be unique per user. Duplicate value(s) between: ${duplicates.join(", ")}.`);
  }
}

// Insert-only: an existing territory row (matched by unique name) is left
// completely alone.
async function seedTerritories(): Promise<void> {
  for (const name of TERRITORIES) {
    await db.insert(territoriesTable).values({ name }).onConflictDoNothing({ target: territoriesTable.name });
  }
}

// Insert-only, and only for users confirmed absent above. onConflictDoNothing
// stays as a defensive no-op guard against a race between the read and this
// write -- it must never fire in the normal path.
async function seedMissingUsers(missingUsers: SeedUser[], passwords: Map<string, string>): Promise<void> {
  for (const user of missingUsers) {
    const passwordHash = hashPassword(passwords.get(user.email)!);
    await db
      .insert(usersTable)
      .values({
        name: user.name,
        email: user.email,
        role: user.role,
        territory: user.territory,
        active: true,
        passwordHash,
      })
      .onConflictDoNothing({ target: usersTable.email });
  }
}

// territories.owner_user_id is the authorization source of truth (see
// services/authz.ts). Before wiring it up we re-resolve every seeded user by
// email (covers both pre-existing and just-inserted accounts) and verify the
// located account's role still matches what this seed expects for that
// identity. A mismatch means the email now belongs to a record this seed
// doesn't recognize as "the same PAM" -- fail loudly instead of silently
// handing that account territory-scoped authorization. (Defense in depth:
// validateExistingSeedRoles() already checked this for pre-existing users
// before any write happened; this re-check also covers users just inserted
// in this run.)
async function assignTerritoryOwners(): Promise<void> {
  const rows = await db
    .select()
    .from(usersTable)
    .where(inArray(usersTable.email, USERS.map((u) => u.email)));
  const byEmail = new Map(rows.map((r) => [r.email, r]));

  for (const user of USERS) {
    if (!user.territory) continue; // Irina: global access, owns no territory

    const owner = byEmail.get(user.email);
    if (!owner) {
      throw new Error(`Expected seeded user ${user.email} to exist after seeding but it was not found.`);
    }
    if (owner.role !== "pam") {
      throw new Error(
        `Refusing to assign territory "${user.territory}" to ${user.email}: the existing account has role ` +
          `"${owner.role}", not "pam" as expected for this seeded identity. This looks like a conflicting/` +
          `pre-existing record -- resolve it manually before re-running the seed.`,
      );
    }

    await db
      .update(territoriesTable)
      .set({ ownerUserId: owner.id })
      .where(and(eq(territoriesTable.name, user.territory), isNull(territoriesTable.ownerUserId)));
  }
}

async function main(): Promise<void> {
  const existing = await loadExistingSeedUsers();
  validateExistingSeedRoles(existing);

  const missingUsers = USERS.filter((u) => !existing.has(u.email));

  // Validate everything (env vars present, length, uniqueness) before any
  // write happens.
  const passwords = readRequiredPasswords(missingUsers);
  validateNewPasswords(missingUsers, passwords);

  await seedTerritories();
  await seedMissingUsers(missingUsers, passwords);
  await assignTerritoryOwners();

  console.log(
    `Seed complete. ${missingUsers.length} user(s) created, ${USERS.length - missingUsers.length} already existed ` +
      `and were left untouched. Territories ensured; ownership assigned where previously unset.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
