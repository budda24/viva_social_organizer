import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

/**
 * Every minute, reclaim botInbox rows stuck in 'processing' past their lease.
 * Resets them to 'pending' so the laptop (or fallback brain) can retry.
 */
export const reclaimStaleInbox = onSchedule(
  { schedule: "every 1 minutes", region: "europe-central2", timeZone: "Europe/Paris" },
  async () => {
    const db = getFirestore();
    const cutoff = Timestamp.now();
    const stale = await db
      .collection("botInbox")
      .where("status", "==", "processing")
      .where("leaseExpiresAt", "<", cutoff)
      .limit(50)
      .get();
    if (stale.empty) return;

    const batch = db.batch();
    for (const doc of stale.docs) {
      batch.update(doc.ref, { status: "pending", leasedBy: null, leaseExpiresAt: null });
    }
    await batch.commit();
  }
);
