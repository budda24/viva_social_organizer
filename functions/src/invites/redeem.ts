import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const CODE_PATTERN = /^VIVA-[A-Z0-9]{4}-[A-Z0-9]{2}$/;

export const redeemInviteCode = onCall(async (req) => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in required");
  }
  const code = String(req.data?.code ?? "").toUpperCase().trim();
  if (!CODE_PATTERN.test(code)) {
    throw new HttpsError("invalid-argument", "Bad code format");
  }

  const db = getFirestore();
  const codeRef = db.doc(`inviteCodes/${code}`);
  const userRef = db.doc(`users/${req.auth.uid}`);

  return db.runTransaction(async (tx) => {
    const [codeSnap, userSnap] = await Promise.all([tx.get(codeRef), tx.get(userRef)]);
    if (!codeSnap.exists) {
      throw new HttpsError("not-found", "Unknown code");
    }
    const c = codeSnap.data()!;
    if (c.disabled) {
      throw new HttpsError("failed-precondition", "Code disabled");
    }
    if (c.expiresAt && (c.expiresAt as Timestamp).toMillis() < Date.now()) {
      throw new HttpsError("failed-precondition", "Code expired");
    }
    if ((c.uses ?? 0) >= (c.maxUses ?? 1)) {
      throw new HttpsError("failed-precondition", "Code exhausted");
    }
    const usedBy: string[] = c.usedBy ?? [];
    if (usedBy.includes(req.auth!.uid)) {
      throw new HttpsError("already-exists", "Already redeemed");
    }

    tx.update(codeRef, {
      uses: FieldValue.increment(1),
      usedBy: FieldValue.arrayUnion(req.auth!.uid),
    });

    if (!userSnap.exists) {
      tx.set(userRef, {
        uid: req.auth!.uid,
        email: req.auth!.token.email ?? null,
        displayName: req.auth!.token.name ?? "",
        photoUrl: req.auth!.token.picture ?? null,
        role: "member",
        status: "invited",
        inviteCodeUsed: code,
        createdAt: FieldValue.serverTimestamp(),
      });
    } else if ((userSnap.data() as any).status === "invited" || !(userSnap.data() as any).status) {
      tx.update(userRef, { inviteCodeUsed: code, status: "invited" });
    }

    return { ok: true, nextStep: "application" };
  });
});
