/**
 * Read-only sanity check for `find me a buddy` multi-match. Loads the live
 * directory + embeddings, then for a few real members prints who the new
 * deterministic ranker would surface, the formatted reply, and the Connect
 * buttons. Sends nothing. Run: npx tsx src/test-buddy-live.ts
 */
import "./env.js";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as fs from "node:fs";
import {
  loadMemberDirectory,
  ensureMemberEmbeddings,
  rankBuddies,
  buildBuddyReply,
  buildBuddyButtons,
} from "./brain.js";
import { msg } from "./i18n.js";

const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (sa && fs.existsSync(sa)) {
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(sa, "utf8"))) });
} else {
  initializeApp({ credential: applicationDefault() });
}
const db = getFirestore();

const members = await loadMemberDirectory(db);
await ensureMemberEmbeddings(members);
console.log(`directory: ${members.length} reachable (joined) members\n`);

const samples = members.slice(0, Math.min(6, members.length));
for (const self of samples) {
  const selfTopics = self.enrichedTopics.length ? self.enrichedTopics : self.topics;
  const selfQueryText = [
    self.goal,
    self.enrichedBio || self.bio,
    selfTopics.join(", "),
    self.enrichedMatchSignals,
    self.enrichedCompany,
    self.lookingFor,
  ]
    .filter((s) => typeof s === "string" && s.trim())
    .join(" | ");

  const buddies = await rankBuddies(members, self.uid, selfQueryText, selfTopics, 3);
  console.log(
    `=== self: ${self.name || self.uid}  topics=[${selfTopics.join(", ")}]  goal="${self.goal}" ===`
  );
  console.log(buildBuddyReply(buddies, "en", msg("en").buddyTapHint));
  console.log(
    "buttons: " + buildBuddyButtons(buddies, "en").map((b) => `[${b.text}] → ${b.data}`).join("  ")
  );
  console.log("");
}
process.exit(0);
