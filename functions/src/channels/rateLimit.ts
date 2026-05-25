import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import type { ChannelId } from "./types";

interface Limits {
  perMinute: number;
  perHour: number;
}

const DEFAULTS: Record<ChannelId, Limits> = {
  twilio: { perMinute: 5, perHour: 50 },
  telegram: { perMinute: 20, perHour: 200 },
};

export type RateCheck =
  | { allowed: true }
  | { allowed: false; reason: "minute" | "hour"; retryAfterSec: number };

/**
 * Sliding-window-ish rate limit per (channel, uid).
 *
 * Stores a doc at rateLimit/{channel}_{uid} with two rolling counters. Both
 * counters reset when their window has elapsed. Returns `allowed: false` if
 * either ceiling is hit; the caller decides whether to send a "slow down"
 * reply or just drop silently. Transaction-safe across concurrent webhooks.
 */
export async function checkAndIncrement(
  channel: ChannelId,
  uid: string,
  limits: Limits = DEFAULTS[channel]
): Promise<RateCheck> {
  const db = getFirestore();
  const ref = db.doc(`rateLimit/${channel}_${uid}`);
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() ?? {};

    const minuteStart = (data.minuteStart as Timestamp | undefined)?.toMillis() ?? 0;
    const hourStart = (data.hourStart as Timestamp | undefined)?.toMillis() ?? 0;
    let minuteCount = (data.minuteCount as number | undefined) ?? 0;
    let hourCount = (data.hourCount as number | undefined) ?? 0;

    let nextMinuteStart = minuteStart;
    let nextHourStart = hourStart;

    if (now - minuteStart >= 60_000) {
      nextMinuteStart = now;
      minuteCount = 0;
    }
    if (now - hourStart >= 3_600_000) {
      nextHourStart = now;
      hourCount = 0;
    }

    if (minuteCount >= limits.perMinute) {
      const retryAfterSec = Math.ceil((nextMinuteStart + 60_000 - now) / 1000);
      return { allowed: false, reason: "minute", retryAfterSec } as RateCheck;
    }
    if (hourCount >= limits.perHour) {
      const retryAfterSec = Math.ceil((nextHourStart + 3_600_000 - now) / 1000);
      return { allowed: false, reason: "hour", retryAfterSec } as RateCheck;
    }

    tx.set(
      ref,
      {
        channel,
        uid,
        minuteStart: Timestamp.fromMillis(nextMinuteStart || now),
        hourStart: Timestamp.fromMillis(nextHourStart || now),
        minuteCount: minuteCount + 1,
        hourCount: hourCount + 1,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { allowed: true } as RateCheck;
  });
}
