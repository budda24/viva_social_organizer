import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as crypto from "node:crypto";

const WHAPI_WEBHOOK_SECRET = defineSecret("WHAPI_WEBHOOK_SECRET");

/**
 * Whapi.cloud inbound message webhook.
 * Verifies HMAC, resolves phone → user, writes botInbox row, returns 200 fast.
 * The laptop-hosted bot brain polls botInbox and processes asynchronously.
 */
export const whapiWebhook = onRequest(
  { secrets: [WHAPI_WEBHOOK_SECRET], region: "europe-central2", invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const signatureHeader = req.header("X-Whapi-Signature") ?? "";
    const rawBody = JSON.stringify(req.body);
    const expected = crypto
      .createHmac("sha256", WHAPI_WEBHOOK_SECRET.value())
      .update(rawBody)
      .digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected))) {
      res.status(401).send("Bad signature");
      return;
    }

    const messages: any[] = req.body?.messages ?? [];
    if (messages.length === 0) {
      res.status(200).send({ ok: true, processed: 0 });
      return;
    }

    const db = getFirestore();
    const writes: Promise<unknown>[] = [];
    for (const m of messages) {
      if (m.from_me) continue;
      const phone = (m.from ?? "").replace(/[^0-9]/g, "");
      const body = String(m?.text?.body ?? "").trim();
      const messageId = m.id;
      if (!phone || !body || !messageId) continue;

      const userSnap = await db
        .collection("users")
        .where("whatsappPhoneE164", "==", `+${phone}`)
        .limit(1)
        .get();
      if (userSnap.empty) continue;
      const userDoc = userSnap.docs[0];
      if (userDoc.data().status !== "approved") continue;

      writes.push(
        db.doc(`botInbox/${messageId}`).set(
          {
            messageId,
            phone: `+${phone}`,
            uid: userDoc.id,
            body,
            receivedAt: FieldValue.serverTimestamp(),
            status: "pending",
            attempts: 0,
          },
          { merge: true }
        )
      );
    }

    await Promise.all(writes);
    res.status(200).send({ ok: true, processed: writes.length });
  }
);
