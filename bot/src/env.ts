/**
 * Load .env files, regardless of cwd. Import this for its side effect at the top
 * of every entry point that needs env vars.
 *
 *   import "./env.js";
 *
 * Loads two files, in order:
 *   1. <project-root>/.env  — shared project config (GOOGLE_CLOUD_PROJECT, …)
 *   2. <bot>/.env           — bot-only secrets (ANTHROPIC_API_KEY, …)
 *
 * dotenv does not override already-set vars, so the root file wins on any key it
 * also defines, and bot/.env only fills in keys the root left unset. Loading
 * bot/.env is what makes ANTHROPIC_API_KEY (the local→Anthropic fallback auth)
 * available under both `tsx` (bot/src/*.ts) and the compiled systemd service
 * (bot/dist/*.js) — both resolve the same relative paths.
 */

import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// 1. Project-root .env (one level above bot/).
const rootEnvPath = path.resolve(here, "..", "..", ".env");
const rootResult = config({ path: rootEnvPath });
if (rootResult.error) {
  console.warn(`[env] no .env loaded at ${rootEnvPath} (${rootResult.error.message})`);
} else {
  console.log(`[env] loaded ${rootEnvPath} · project=${process.env.GOOGLE_CLOUD_PROJECT ?? "(unset)"}`);
}

// 2. bot/.env (one level above src/dist). Holds ANTHROPIC_API_KEY for the fallback.
const botEnvPath = path.resolve(here, "..", ".env");
const botResult = config({ path: botEnvPath });
if (botResult.error) {
  console.warn(`[env] no bot .env loaded at ${botEnvPath} (${botResult.error.message})`);
} else {
  console.log(`[env] loaded ${botEnvPath} · anthropicKey=${process.env.ANTHROPIC_API_KEY ? "set" : "(unset)"}`);
}
