/**
 * Load .env from the project root (one level above bot/), regardless of cwd.
 * Import this for its side effect at the top of every entry point that needs env vars.
 *
 *   import "./env.js";
 *
 * Works both for tsx (bot/src/*.ts) and compiled output (bot/dist/*.js) —
 * both resolve to <project-root>/.env via the same relative path.
 */

import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, "..", "..", ".env");
const result = config({ path: envPath });

if (result.error) {
  console.warn(`[env] no .env loaded at ${envPath} (${result.error.message})`);
} else {
  console.log(`[env] loaded ${envPath} · project=${process.env.GOOGLE_CLOUD_PROJECT ?? "(unset)"}`);
}
