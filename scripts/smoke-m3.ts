// M3 smoke: seed a user + session directly, then exercise the API over HTTP.
// Credential + audit paths need no Google; bucket create (which needs Drive) is
// only checked for correct auth/CSRF gating here.
import { openDatabase } from "../apps/server/src/db/connection.ts";
import { runMigrations } from "../apps/server/src/db/migrate.ts";
import { UsersRepository } from "../apps/server/src/db/repositories/users.ts";
import { SessionsRepository } from "../apps/server/src/db/repositories/sessions.ts";
import { hashSessionId } from "../apps/server/src/auth/session.ts";
import { nowIso } from "../apps/server/src/util/ids.ts";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const path = process.env.SQLITE_PATH ?? "./data/app.sqlite";
const db = openDatabase(path);
runMigrations(db);
const users = new UsersRepository(db);
const sessions = new SessionsRepository(db);
const user = users.upsertOnLogin({
  googleSub: "smoke-sub",
  email: "smoke@example.com",
  displayName: "Smoke",
  hostedDomain: "example.com",
});
const rawId = randomBytes(32).toString("base64url");
const csrf = randomBytes(16).toString("base64url");
sessions.create({
  idHash: hashSessionId(rawId),
  userId: user.id,
  csrfSecret: csrf,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  userAgent: "smoke",
  ipHash: null,
  mfaPending: false,
});
db.close();
writeFileSync("/tmp/smoke_raw", rawId);
writeFileSync("/tmp/smoke_csrf", csrf);
process.stdout.write(JSON.stringify({ rawId, csrf, userId: user.id }) + "\n");
