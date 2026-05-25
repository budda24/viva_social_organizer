/**
 * One-shot: seed a handful of fake Viva Tribe members with profiles the bot
 * can use for matching. Idempotent — re-running just updates the same rows.
 *
 * Usage:
 *   npx tsx src/seed-test-users.ts
 *   npx tsx src/seed-test-users.ts --wipe   # also delete users from a previous run
 */

import "./env.js";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const wipe = process.argv.includes("--wipe");

interface TestMember {
  uid: string;
  displayName: string;
  bio: string;
  topics: string[];
  lookingFor: string;
  city: string;
}

const members: TestMember[] = [
  {
    uid: "u-marcus",
    displayName: "Marcus Højlund",
    bio: "Boutique European fund, early-stage",
    topics: ["AI", "fintech", "health-tech"],
    lookingFor: "deep-tech founders raising seed/A",
    city: "Copenhagen",
  },
  {
    uid: "u-lea",
    displayName: "Léa Mercier",
    bio: "Scope-3 carbon for industrials",
    topics: ["climate-tech", "B2B SaaS", "carbon"],
    lookingFor: "enterprise pilot partners in heavy industry",
    city: "Berlin / Paris",
  },
  {
    uid: "u-yuki",
    displayName: "Yuki Tanaka",
    bio: "Agentic CRM, solo, week 7",
    topics: ["AI", "SaaS", "sales-automation"],
    lookingFor: "design-partner sales teams",
    city: "Tokyo",
  },
  {
    uid: "u-tom",
    displayName: "Tom Adebayo",
    bio: "Evals infra for production agents",
    topics: ["AI", "devtools", "observability"],
    lookingFor: "AI lab + applied-AI team intros",
    city: "London",
  },
  {
    uid: "u-henrik",
    displayName: "Henrik Voss",
    bio: "Ex-Spotify · €4 angel cheques",
    topics: ["consumer", "marketplaces", "audio"],
    lookingFor: "consumer founders pre-seed",
    city: "Stockholm",
  },
  {
    uid: "u-ana",
    displayName: "Ana Ferreira",
    bio: "Second-hand luxury · auth & resale",
    topics: ["consumer", "circular", "marketplaces"],
    lookingFor: "warehouse-ops talent and re-commerce VCs",
    city: "Lisbon",
  },
  {
    uid: "u-jules",
    displayName: "Jules Bertrand",
    bio: "Photonic chips for inference",
    topics: ["hardware", "AI infra", "semiconductors"],
    lookingFor: "enterprise PoC opportunities for low-power inference",
    city: "Paris",
  },
];

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

if (wipe) {
  const batch = db.batch();
  for (const m of members) batch.delete(db.doc(`users/${m.uid}`));
  await batch.commit();
  console.log(`[seed] wiped ${members.length} test users`);
}

for (const m of members) {
  await db.doc(`users/${m.uid}`).set(
    {
      displayName: m.displayName,
      bio: m.bio,
      topics: m.topics,
      lookingFor: m.lookingFor,
      city: m.city,
      status: "approved",
      role: "member",
      consentWhatsappMessages: true,
      isTestData: true,
      onboarding: { step: "complete" },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  console.log(`[seed] users/${m.uid} → ${m.displayName} (${m.topics.join(", ")})`);
}

console.log(`[seed] done · ${members.length} members ready for matching`);
process.exit(0);
