import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// The public "/" landing page shows a live "N tribers" count. The users/
// directory itself is sign-in gated (firestore.rules: read if isSignedIn()),
// so signed-out visitors on the landing page can't read users/ to count
// members — and relaxing that rule would expose the whole directory publicly.
// Instead we keep a tiny world-readable aggregate doc (public/stats) that this
// trigger recomputes on every user write. Self-healing: a full recount each
// time rather than incrementing, which can't drift.

export const onUserWrite = onDocumentWritten(
  {
    document: "users/{uid}",
    region: "europe-central2",
  },
  async () => {
    const db = getFirestore();
    // memberCount = everyone who isn't opted out — mirrors what the directory
    // (members_screen.dart) actually renders. Two aggregate counts keep this
    // billed as O(1), not a full read of every user doc.
    const [total, optedOut] = await Promise.all([
      db.collection("users").count().get(),
      db.collection("users").where("status", "==", "opted_out").count().get(),
    ]);
    const memberCount = Math.max(0, total.data().count - optedOut.data().count);
    await db.doc("public/stats").set(
      {
        memberCount,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  },
);
