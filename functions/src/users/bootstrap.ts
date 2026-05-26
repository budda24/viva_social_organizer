/**
 * bootstrapUserProfile — idempotent callable that creates / refreshes the
 * users/{uid} record from the caller's authenticated identity (LinkedIn OIDC
 * claims via Firebase Auth).
 *
 * Called from the client immediately after a successful sign-in popup. The
 * client can't write users/{uid} directly (rules block it), so this is the
 * canonical path to seed a profile.
 *
 * Behaviour:
 *  - Doc missing → create with status "signed_in", identity from token claims,
 *    server timestamps for createdAt / lastLoginAt.
 *  - Doc exists  → refresh email / displayName / photoUrl from the latest
 *    token claims (in case the user updated them on LinkedIn) and bump
 *    lastLoginAt. Status, role, onboarding, channel bindings etc. are NOT
 *    touched — those belong to redeemInviteCode / the bot / admin flows.
 *
 * Returns { uid, isNew, status } so the client can route post-login:
 *  - isNew: true on first sign-in (decide whether to show code-entry screen)
 *  - status: current member status if you want to fork on it
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export const bootstrapUserProfile = onCall(async (req) => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in required");
  }
  const { uid, token } = req.auth;

  const db = getFirestore();
  const userRef = db.doc(`users/${uid}`);

  // Pull identity from the token rather than trusting client-side input. For
  // LinkedIn OIDC these come from the `id_token` claims minted by Firebase
  // after the OIDC handshake.
  const email = (token.email as string | undefined) ?? null;
  const displayName = (token.name as string | undefined) ?? "";
  const photoUrl = (token.picture as string | undefined) ?? null;
  const provider =
    typeof token.firebase?.sign_in_provider === "string"
      ? token.firebase.sign_in_provider
      : null;

  const snap = await userRef.get();
  const isNew = !snap.exists;

  if (isNew) {
    await userRef.set({
      uid,
      email,
      displayName,
      photoUrl,
      signInProvider: provider,
      role: "member",
      status: "signed_in",
      createdAt: FieldValue.serverTimestamp(),
      lastLoginAt: FieldValue.serverTimestamp(),
    });
    return { uid, isNew: true, status: "signed_in" };
  }

  // Doc exists — refresh only identity fields + lastLoginAt. Don't clobber
  // status / role / onboarding / channel IDs which other code paths own.
  await userRef.update({
    email,
    displayName,
    photoUrl,
    signInProvider: provider,
    lastLoginAt: FieldValue.serverTimestamp(),
  });

  const data = snap.data() ?? {};
  return {
    uid,
    isNew: false,
    status: (data.status as string | undefined) ?? "signed_in",
  };
});
