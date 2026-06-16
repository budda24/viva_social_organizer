import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret, defineString } from "firebase-functions/params";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

/**
 * Brain watchdog — pages Franek when the laptop brain goes down.
 *
 * Why this lives in the cloud: the brain (the LLM poller) runs on a laptop and
 * writes system/botHeartbeat every 15s. If we monitored from the laptop we'd
 * learn nothing when the laptop itself is the thing that's down. This scheduled
 * function runs on Cloud Functions, independent of the laptop, so it still fires
 * when the machine is off, asleep, crashed, or offline.
 *
 * Two failure modes it catches:
 *   1. Heartbeat stale — no beat for OFFLINE_MS → laptop/bot/network down.
 *   2. Ollama down — beat is fresh but ollamaOk === false → the LLM is wedged
 *      even though the process is alive (probe written by bot/src/index.ts).
 *
 * Edge-triggered: it only alerts on the healthy↔down transition (and re-pings
 * every RENOTIFY_MS while still down), so a brief restart doesn't spam you and a
 * long outage doesn't go silent. State is kept in system/watchdogState.
 */

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
// Franek's personal chat id with the bot (DM the bot once, then read it — see
// bot/src/whois.ts). Leave empty to skip the Telegram alert.
const WATCHDOG_TELEGRAM_CHAT_ID = defineString("WATCHDOG_TELEGRAM_CHAT_ID", { default: "" });

// Grace period before a missing heartbeat counts as down. The bot beats every
// 15s; we allow longer than the webhook's 90s so a quick `systemctl restart`
// doesn't page anyone. Bump via the WATCHDOG_OFFLINE_MS env if you want.
const OFFLINE_MS = Number(process.env.WATCHDOG_OFFLINE_MS ?? 180_000);
// While still down, re-ping at most this often so a long outage stays visible.
const RENOTIFY_MS = Number(process.env.WATCHDOG_RENOTIFY_MS ?? 30 * 60_000);

interface Verdict {
  down: boolean;
  reason: string;
}

function evaluate(data: FirebaseFirestore.DocumentData | undefined): Verdict {
  const last = data?.lastSeenAt as Timestamp | undefined;
  if (!last) return { down: true, reason: "no heartbeat document — brain has never checked in" };
  const ageSec = Math.round((Date.now() - last.toMillis()) / 1000);
  if (Date.now() - last.toMillis() > OFFLINE_MS) {
    return {
      down: true,
      reason: `no heartbeat for ${ageSec}s (host ${data?.hostId ?? "?"}) — laptop/bot offline`,
    };
  }
  // Heartbeat is fresh → the process is alive. Only now is ollamaOk meaningful.
  // Treat undefined (bot not yet redeployed) as healthy to avoid false alarms.
  if (data?.ollamaOk === false) {
    return {
      down: true,
      reason: `LLM unreachable while process is up — ${data?.ollamaError ?? "ollama probe failed"}`,
    };
  }
  return { down: false, reason: `healthy (last beat ${ageSec}s ago)` };
}

async function sendTelegram(text: string): Promise<void> {
  const chatId = WATCHDOG_TELEGRAM_CHAT_ID.value();
  const token = TELEGRAM_BOT_TOKEN.value();
  if (!chatId || !token) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_notification: false }),
    });
    if (!res.ok) console.error(`[watchdog] telegram alert ${res.status}: ${await res.text()}`);
  } catch (e) {
    console.error("[watchdog] telegram alert failed:", e);
  }
}

async function alert(text: string): Promise<void> {
  await sendTelegram(text);
}

export const brainWatchdog = onSchedule(
  {
    schedule: "every 1 minutes",
    region: "europe-central2",
    timeZone: "Europe/Paris",
    secrets: [TELEGRAM_BOT_TOKEN],
  },
  async () => {
    const db = getFirestore();
    const beat = await db.doc("system/botHeartbeat").get();
    const verdict = evaluate(beat.data());

    const stateRef = db.doc("system/watchdogState");
    const prev = (await stateRef.get()).data() as
      | { status?: "healthy" | "down"; notifiedAt?: Timestamp }
      | undefined;
    const prevStatus = prev?.status ?? "healthy";
    const status: "healthy" | "down" = verdict.down ? "down" : "healthy";

    const changed = status !== prevStatus;
    const lastNotifiedMs = prev?.notifiedAt?.toMillis() ?? 0;
    const stale = verdict.down && Date.now() - lastNotifiedMs > RENOTIFY_MS;

    if (changed && status === "down") {
      await alert(`🔴 Tribu brain DOWN — ${verdict.reason}`);
    } else if (changed && status === "healthy") {
      await alert("🟢 Tribu brain back online.");
    } else if (stale) {
      await alert(`🔴 Tribu brain STILL down — ${verdict.reason}`);
    }

    const notifiedNow = (changed && status === "down") || (changed && status === "healthy") || stale;
    await stateRef.set(
      {
        status,
        reason: verdict.reason,
        checkedAt: FieldValue.serverTimestamp(),
        ...(status === "down" && !changed ? {} : { since: FieldValue.serverTimestamp() }),
        ...(notifiedNow ? { notifiedAt: FieldValue.serverTimestamp() } : {}),
      },
      { merge: true }
    );
  }
);
