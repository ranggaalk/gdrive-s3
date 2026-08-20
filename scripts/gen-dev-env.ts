// Dev-only helper: fill .env with random secrets if they are blank.
// Not used in production. Run: bun scripts/gen-dev-env.ts
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";

const envPath = ".env";
if (!existsSync(envPath)) copyFileSync(".env.example", envPath);

const mk = randomBytes(32).toString("base64");
const ss = randomBytes(48).toString("base64");

const out = readFileSync(envPath, "utf8")
  .split("\n")
  .map((line) => {
    if (line.startsWith("MASTER_ENCRYPTION_KEY=") && line.trim() === "MASTER_ENCRYPTION_KEY=")
      return `MASTER_ENCRYPTION_KEY=${mk}`;
    if (line.startsWith("SESSION_SECRET=") && line.trim() === "SESSION_SECRET=")
      return `SESSION_SECRET=${ss}`;
    if (line.startsWith("GOOGLE_CLIENT_ID=") && line.trim() === "GOOGLE_CLIENT_ID=")
      return "GOOGLE_CLIENT_ID=dev-client-id";
    if (line.startsWith("GOOGLE_CLIENT_SECRET=") && line.trim() === "GOOGLE_CLIENT_SECRET=")
      return "GOOGLE_CLIENT_SECRET=dev-client-secret";
    return line;
  })
  .join("\n");

writeFileSync(envPath, out);
process.stdout.write("dev .env populated\n");
