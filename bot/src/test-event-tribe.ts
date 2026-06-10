/**
 * End-to-end check for the auto-created event group chat. Resolves the configured
 * service owner, creates a throwaway tribe under it, prints the invite link, then
 * deletes it. Confirms OT_DEFAULT_OWNER_USERNAME resolves + the create/delete path
 * works, without touching Telegram. Run: npx tsx src/test-event-tribe.ts
 */
import "./env.js";
import {
  createTribeForHost,
  deleteTribeForEvent,
  tribeIdFromLink,
  isOnlineTribesConfigured,
} from "./online-tribes.js";

const owner = process.env.OT_DEFAULT_OWNER_USERNAME?.trim();
console.log(`configured=${isOnlineTribesConfigured()} owner=${owner ?? "(unset)"}`);
if (!isOnlineTribesConfigured() || !owner) {
  console.log("integration or owner not configured — nothing to test");
  process.exit(1);
}

const created = await createTribeForHost({
  ownerUsername: owner,
  name: `TEST Viva flow ${Date.now()} (auto-delete)`,
  bio: "Temporary test tribe from the Viva connector — safe to ignore, auto-deleted.",
});
console.log("create →", JSON.stringify(created));

if (created.ok) {
  console.log("inviteLink →", created.inviteLink);
  const tid = created.tribeId ?? tribeIdFromLink(created.inviteLink);
  if (tid) {
    const del = await deleteTribeForEvent(tid);
    console.log("delete →", JSON.stringify(del));
  }
}
process.exit(0);
