import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { resolveUserByChannel } from "../identity";
import { checkAndIncrement } from "../rateLimit";

const TELEGRAM_WEBHOOK_SECRET = defineSecret("TELEGRAM_WEBHOOK_SECRET");

const INVITE_CODE_PATTERN = /^VIVA-[A-Z0-9]{4}-[A-Z0-9]{2}$/;

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}

// Telegram sends an IETF tag like "fr", "fr-FR", "en-US". We support EN + FR;
// anything else defaults to English.
function langFromTelegram(code: string | undefined): "en" | "fr" {
  return (code ?? "").toLowerCase().startsWith("fr") ? "fr" : "en";
}
interface TgChat {
  id: number;
  type: string;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

/**
 * Telegram Bot API webhook.
 *
 * Telegram POSTs Update objects as application/json. Authentication is via
 * the `X-Telegram-Bot-Api-Secret-Token` header — we set this secret when
 * registering the webhook URL with Telegram's setWebhook API.
 *
 * Two paths:
 *   1. `/start <inviteCode>` — first message after deep-link click. We look
 *      up the (single-use) invite code, bind users/{uid}.telegramChatId, and
 *      queue a welcome reply.
 *   2. Any other message from an already-bound chat — resolve chatId → uid,
 *      rate-limit, write a botInbox row for the laptop brain to pick up.
 *
 * Always returns 200 quickly. Errors and ignored cases also return 200 so
 * Telegram doesn't retry-storm us.
 */
export const telegramWebhook = onRequest(
  {
    secrets: [TELEGRAM_WEBHOOK_SECRET],
    region: "europe-central2",
    invoker: "public",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const expected = TELEGRAM_WEBHOOK_SECRET.value();
    const provided = req.header("x-telegram-bot-api-secret-token") ?? "";
    if (!expected || provided !== expected) {
      console.warn("[telegramWebhook] missing/bad secret token");
      res.status(403).send("Forbidden");
      return;
    }

    const update = req.body as TgUpdate | undefined;
    const message = update?.message;
    if (!message || !message.text || message.chat.type !== "private") {
      res.status(200).send("ok");
      return;
    }

    const chatId = message.chat.id;
    const text = message.text.trim();
    const username = message.from?.username;
    const displayName =
      [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") ||
      username ||
      undefined;
    const lang = langFromTelegram(message.from?.language_code);

    const db = getFirestore();

    // Path 1: /start <inviteCode> — binding flow.
    if (text.startsWith("/start ")) {
      const code = text.slice("/start ".length).trim().toUpperCase();
      const handled = await handleStart({
        db,
        code,
        chatId,
        username,
        displayName,
        lang,
      });
      if (!handled.ok) {
        console.warn(`[telegramWebhook] /start failed: ${handled.reason}`);
        await queueReply(db, {
          chatId,
          uid: handled.uid ?? "unbound",
          body: handled.userMessage,
        });
      }
      res.status(200).send("ok");
      return;
    }

    // /start with no code — friendly nudge.
    if (text === "/start") {
      await queueReply(db, {
        chatId,
        uid: "unbound",
        body: "Open your invite link from the Viva Tribe site to connect this chat.",
      });
      res.status(200).send("ok");
      return;
    }

    // Path 2: bound chat → normal brain processing.
    const user = await resolveUserByChannel("telegram", chatId);
    if (!user) {
      console.warn(`[telegramWebhook] no bound user for chatId=${chatId}`);
      await queueReply(db, {
        chatId,
        uid: "unbound",
        body: "I don't recognise this chat yet. Click the Telegram link from your Viva Tribe invite to connect.",
      });
      res.status(200).send("ok");
      return;
    }

    const rate = await checkAndIncrement("telegram", user.uid);
    if (!rate.allowed) {
      console.warn(
        `[telegramWebhook] rate-limited uid=${user.uid} reason=${rate.reason} retryAfter=${rate.retryAfterSec}s`
      );
      res.status(200).send("ok");
      return;
    }

    const messageId = `tg-${update!.update_id}`;
    await db.doc(`botInbox/${messageId}`).set(
      {
        messageId,
        provider: "telegram",
        chatId,
        tgUsername: username ?? null,
        uid: user.uid,
        body: text,
        receivedAt: FieldValue.serverTimestamp(),
        status: "pending",
        attempts: 0,
      },
      { merge: true }
    );

    res.status(200).send("ok");
  }
);

interface StartResult {
  ok: boolean;
  reason?: string;
  uid?: string;
  userMessage: string;
}

async function handleStart(args: {
  db: FirebaseFirestore.Firestore;
  code: string;
  chatId: number;
  username?: string;
  displayName?: string;
  lang: "en" | "fr";
}): Promise<StartResult> {
  const { db, code, chatId, username, displayName, lang } = args;

  if (!INVITE_CODE_PATTERN.test(code)) {
    return {
      ok: false,
      reason: "bad-code-format",
      userMessage: "That invite link looks invalid. Try opening it from your Viva Tribe email again.",
    };
  }

  const codeRef = db.doc(`inviteCodes/${code}`);
  return db.runTransaction(async (tx) => {
    const codeSnap = await tx.get(codeRef);
    if (!codeSnap.exists) {
      return {
        ok: false,
        reason: "unknown-code",
        userMessage: "Invite code not found. Check the link from your Viva Tribe invite.",
      };
    }
    const c = codeSnap.data()!;
    if (c.disabled) {
      return { ok: false, reason: "disabled", userMessage: "This invite has been disabled." };
    }
    if (c.expiresAt && (c.expiresAt as Timestamp).toMillis() < Date.now()) {
      return { ok: false, reason: "expired", userMessage: "This invite has expired." };
    }

    const usedBy: string[] = c.usedBy ?? [];
    if (usedBy.length !== 1) {
      return {
        ok: false,
        reason: "unredeemed-or-multi-use",
        userMessage: "Sign in on the Viva Tribe site first, then open the Telegram link again.",
      };
    }
    const uid = usedBy[0];

    const userRef = db.doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      return {
        ok: false,
        reason: "user-missing",
        userMessage: "Your account isn't set up yet. Finish sign-in on the Viva Tribe site first.",
      };
    }

    // Respect a language the user already chose in-bot; otherwise use the
    // Telegram-detected locale.
    const existingLang = userSnap.data()?.preferredLanguage as
      | string
      | undefined;
    const effectiveLang: "en" | "fr" =
      existingLang === "fr" || existingLang === "en"
        ? existingLang
        : lang;

    // Bind chat and mark onboarding complete — LinkedIn login is the
    // approved-membership gate, so we skip the goal/energy questions and
    // greet with the command menu instead. The bot brain treats step=complete
    // as "skip onboarding, go straight to Claude". preferredLanguage seeds the
    // bot's localization (changeable later via the `language` command).
    tx.update(userRef, {
      telegramChatId: chatId,
      telegramUsername: username ?? null,
      telegramDisplayName: displayName ?? null,
      telegramBoundAt: FieldValue.serverTimestamp(),
      preferredLanguage: effectiveLang,
      "onboarding.step": "complete",
      "onboarding.completedAt": FieldValue.serverTimestamp(),
    });

    const greetingName =
      (userSnap.data()?.displayName as string | undefined) ?? displayName ?? "there";
    const reply =
      effectiveLang === "fr"
        ? `Bienvenue ${greetingName} ! Je suis Tribu — je t'aide à rencontrer les bonnes personnes à VivaTech.\n\n` +
          "Voici ce que je peux faire :\n" +
          "• trouve-moi un binôme — quelqu'un avec qui explorer VivaTech\n" +
          "• trouve-moi <sujet> — des personnes précises (ex. « trouve-moi un VC climat »)\n" +
          "• créer événement — propose un rendez-vous (je préviens tout le monde)\n" +
          "• qui est là — voir les membres actifs\n" +
          "• libre 30 — signale que tu es dispo\n" +
          "• langue — changer English / Français\n" +
          "• help — revoir ce menu\n" +
          "• stop — ne plus recevoir de messages"
        : `Welcome ${greetingName}! I'm Tribu — I help you meet the right humans at VivaTech.\n\n` +
          "Here's what I can do:\n" +
          "• find me a buddy — someone to explore VivaTech with\n" +
          "• find me <topic> — specific people (e.g. \"find me a climate VC\")\n" +
          "• create event — propose a micro-event (I'll ping everyone)\n" +
          "• who is here — see active members\n" +
          "• free for 30 — set your availability\n" +
          "• language — switch English / Français\n" +
          "• help — see this menu again\n" +
          "• stop — opt out";
    tx.set(db.collection("whatsappOutbox").doc(), {
      recipientType: "individual",
      recipientUid: uid,
      recipientChatId: chatId,
      type: "telegram_welcome",
      provider: "telegram",
      body: reply,
      status: "queued",
      attempts: 0,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { ok: true, uid, userMessage: reply };
  });
}

async function queueReply(
  db: FirebaseFirestore.Firestore,
  args: { chatId: number; uid: string; body: string }
) {
  await db.collection("whatsappOutbox").add({
    recipientType: "individual",
    recipientUid: args.uid,
    recipientChatId: args.chatId,
    type: "system_notice",
    provider: "telegram",
    body: args.body,
    status: "queued",
    attempts: 0,
    createdAt: FieldValue.serverTimestamp(),
  });
}
