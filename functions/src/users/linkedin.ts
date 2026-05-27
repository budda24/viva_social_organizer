/**
 * linkedinSignIn — server-side LinkedIn OAuth code exchange + Firebase custom-
 * token minting. Bypasses Firebase Auth's built-in OIDC integration, which
 * sends `client_secret` via HTTP Basic auth — LinkedIn requires it in the
 * request body (`client_secret_post`) and rejects with "client_secret missing"
 * otherwise.
 *
 * Flow:
 *  1. Client redirects user to LinkedIn auth URL (with our redirect_uri).
 *  2. LinkedIn redirects user back to /auth/linkedin/callback?code=…
 *  3. Callback screen calls this function with { code, redirectUri }.
 *  4. This function:
 *     - POSTs to LinkedIn token endpoint with client_secret in body.
 *     - Fetches userinfo with the resulting access token.
 *     - Creates/updates the Firebase Auth user (uid = `linkedin:<sub>`).
 *     - Creates/updates users/{uid} Firestore doc (mirrors bootstrap shape).
 *     - Mints a custom Firebase token tied to that uid.
 *  5. Client calls signInWithCustomToken(returnedToken) — user is signed in.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const LINKEDIN_CLIENT_ID = defineSecret("LINKEDIN_CLIENT_ID");
const LINKEDIN_CLIENT_SECRET = defineSecret("LINKEDIN_CLIENT_SECRET");

interface LinkedInTokenResponse {
  access_token: string;
  expires_in: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
}

interface LinkedInUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
  picture?: string;
  locale?: string;
}

function fullName(u: LinkedInUserInfo): string {
  if (u.name && u.name.trim()) return u.name.trim();
  const joined = `${u.given_name ?? ""} ${u.family_name ?? ""}`.trim();
  return joined || "";
}

export const linkedinSignIn = onCall(
  { secrets: [LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET] },
  async (req) => {
    const code = String(req.data?.code ?? "").trim();
    const redirectUri = String(req.data?.redirectUri ?? "").trim();
    if (!code || !redirectUri) {
      throw new HttpsError(
        "invalid-argument",
        "code + redirectUri required"
      );
    }

    // 1. Exchange the authorization code for an access token. LinkedIn
    //    requires client_secret in the form body (client_secret_post), NOT
    //    HTTP Basic auth — that's the whole reason this function exists.
    const tokenResp = await fetch(
      "https://www.linkedin.com/oauth/v2/accessToken",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: LINKEDIN_CLIENT_ID.value(),
          client_secret: LINKEDIN_CLIENT_SECRET.value(),
        }).toString(),
      }
    );

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error(
        "[linkedinSignIn] token exchange failed",
        tokenResp.status,
        errText
      );
      throw new HttpsError(
        "internal",
        `LinkedIn token exchange failed (${tokenResp.status})`
      );
    }
    const tokens = (await tokenResp.json()) as LinkedInTokenResponse;

    // 2. Fetch the user's identity from LinkedIn's OIDC userinfo endpoint.
    const userResp = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userResp.ok) {
      const errText = await userResp.text();
      console.error(
        "[linkedinSignIn] userinfo failed",
        userResp.status,
        errText
      );
      throw new HttpsError(
        "internal",
        `LinkedIn userinfo failed (${userResp.status})`
      );
    }
    const userInfo = (await userResp.json()) as LinkedInUserInfo;
    if (!userInfo.sub) {
      throw new HttpsError("internal", "LinkedIn userinfo missing sub");
    }

    // 3. Create or refresh the Firebase Auth user. uid encodes the LinkedIn
    //    sub so re-logins always resolve to the same Firebase identity.
    const auth = getAuth();
    const uid = `linkedin:${userInfo.sub}`;
    const displayName = fullName(userInfo);
    const authProfile = {
      email: userInfo.email,
      displayName: displayName || undefined,
      photoURL: userInfo.picture,
      emailVerified: !!userInfo.email_verified,
    };

    try {
      await auth.getUser(uid);
      await auth.updateUser(uid, authProfile);
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === "auth/user-not-found") {
        await auth.createUser({ uid, ...authProfile });
      } else {
        throw e;
      }
    }

    // 4. Mirror identity into users/{uid}. Same shape as bootstrapUserProfile
    //    so anything downstream (member directory, rules) sees the user even
    //    before redeemInviteCode flips them to "invited".
    //
    //    Also kick off the async enrichment worker for first-time sign-ups by
    //    setting enrichment.status = "pending". The worker (bot/src/enrich.ts)
    //    picks these up, web-searches the person from name/email/linkedinId,
    //    and writes back enriched bio/topics/company/matchSignals — those are
    //    the fields the bot's buddy-matching uses. `linkedinId` mirrors
    //    `linkedinSub` so the worker (which reads `linkedinId`) finds it.
    const db = getFirestore();
    const userRef = db.doc(`users/${uid}`);
    const snap = await userRef.get();
    const profile = {
      email: userInfo.email ?? null,
      displayName: displayName || "",
      photoUrl: userInfo.picture ?? null,
      signInProvider: "linkedin",
      linkedinSub: userInfo.sub,
      linkedinId: userInfo.sub,
    };
    if (!snap.exists) {
      // PROTOTYPE: auto-approve LinkedIn signups so they immediately show in
      // the directory + can read other approved members. For production-style
      // gated approval (Franek vets each application), change this to
      // "signed_in" and have an admin flip it to "approved" manually.
      await userRef.set({
        uid,
        ...profile,
        role: "member",
        status: "approved",
        createdAt: FieldValue.serverTimestamp(),
        lastLoginAt: FieldValue.serverTimestamp(),
        enrichment: { status: "pending" },
      });
    } else {
      // Existing user: refresh identity but don't disturb any in-progress or
      // completed enrichment. Only seed enrichment.status if the field is
      // entirely absent (legacy users created before this worker existed).
      const data = snap.data() ?? {};
      const updates: Record<string, unknown> = {
        ...profile,
        lastLoginAt: FieldValue.serverTimestamp(),
      };
      if (!data.enrichment || typeof data.enrichment !== "object") {
        updates.enrichment = { status: "pending" };
      }
      await userRef.update(updates);
    }

    // 5. Mint a Firebase custom token the client uses with signInWithCustomToken.
    const customToken = await auth.createCustomToken(uid, {
      provider: "linkedin",
      linkedinSub: userInfo.sub,
    });

    return {
      customToken,
      uid,
      isNew: !snap.exists,
      profile: {
        email: userInfo.email ?? null,
        name: displayName,
        picture: userInfo.picture ?? null,
      },
    };
  }
);
