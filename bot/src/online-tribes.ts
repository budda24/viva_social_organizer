/**
 * Online Tribes integration — create a per-event "tribe" (group chat) owned by
 * the event host, and get its shareable invite link.
 *
 * Online Tribes is a SEPARATE Firebase project; its `createTribeCallable` is
 * App-Check + user-auth gated, so we can't call it from here. Instead the OT app
 * exposes `createPartnerTribe` (functions/src/modules/payments/createPartnerTribe.ts
 * in the online_tribes_app repo) — a shared-secret HTTP endpoint that resolves an
 * OT username to its user and creates a tribe owned by them. We POST to it.
 *
 * Config (bot/.env, loaded by env.ts):
 *   OT_TRIBE_ENDPOINT_URL — the deployed createPartnerTribe URL
 *   OT_TRIBE_SECRET       — the BOT_CREATE_TRIBE_SECRET shared with the OT app
 * Both unset ⇒ feature off; createTribeForHost returns { ok:false, reason:"not_configured" }.
 */

export type CreateTribeResult =
  | { ok: true; tribeId: string; inviteLink: string }
  | { ok: false; reason: "username_not_found" | "not_configured" | "error" };

const TIMEOUT_MS = Number(process.env.OT_TRIBE_TIMEOUT_MS ?? 12_000);

/** Whether the Online Tribes integration is configured (else the feature is off). */
export function isOnlineTribesConfigured(): boolean {
  return !!process.env.OT_TRIBE_ENDPOINT_URL && !!process.env.OT_TRIBE_SECRET;
}

export type ResolveOwnerResult =
  | { ok: true; ownerUsername: string; ownerName: string }
  | { ok: false; reason: "username_not_found" | "not_configured" | "error" };

/**
 * Resolve an OT username to its owner WITHOUT creating a tribe (resolveOnly).
 * Lets the bot confirm "Found @X (Name) — that you?" before committing, so a
 * mistyped handle that matches a stranger never silently gets the group.
 */
export async function resolveOtOwner(username: string): Promise<ResolveOwnerResult> {
  const url = process.env.OT_TRIBE_ENDPOINT_URL;
  const secret = process.env.OT_TRIBE_SECRET;
  if (!url || !secret) return { ok: false, reason: "not_configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      // `name` is required by the shared payload shape but unused for resolveOnly.
      body: JSON.stringify({ ownerUsername: username, name: "resolve", resolveOnly: true }),
      signal: controller.signal,
    });
    if (res.status === 404) return { ok: false, reason: "username_not_found" };
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[online-tribes] resolveOnly ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, reason: "error" };
    }
    const json = (await res.json()) as { ownerUsername?: string; ownerName?: string };
    if (!json.ownerUsername) {
      // Endpoint not yet upgraded to support resolveOnly — caller falls back.
      return { ok: false, reason: "error" };
    }
    return { ok: true, ownerUsername: json.ownerUsername, ownerName: json.ownerName || json.ownerUsername };
  } catch (e) {
    console.error(`[online-tribes] resolveOnly failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}

export async function createTribeForHost(args: {
  ownerUsername: string;
  name: string;
  bio?: string;
  themes?: string[];
}): Promise<CreateTribeResult> {
  const url = process.env.OT_TRIBE_ENDPOINT_URL;
  const secret = process.env.OT_TRIBE_SECRET;
  if (!url || !secret) return { ok: false, reason: "not_configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        ownerUsername: args.ownerUsername,
        name: args.name,
        bio: args.bio,
        themes: args.themes,
      }),
      signal: controller.signal,
    });

    if (res.status === 404) return { ok: false, reason: "username_not_found" };
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[online-tribes] createPartnerTribe ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, reason: "error" };
    }
    const json = (await res.json()) as { tribeId?: string; inviteLink?: string };
    if (!json.inviteLink || !json.tribeId) {
      console.error("[online-tribes] createPartnerTribe ok but missing inviteLink/tribeId");
      return { ok: false, reason: "error" };
    }
    return { ok: true, tribeId: json.tribeId, inviteLink: json.inviteLink };
  } catch (e) {
    console.error(`[online-tribes] createPartnerTribe failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}

export type DeleteTribeResult =
  | { ok: true; deleted: boolean }
  | { ok: false; reason: "not_configured" | "not_partner" | "error" };

// The delete endpoint sits next to create in the same OT project/region, so we
// derive its URL from OT_TRIBE_ENDPOINT_URL unless explicitly overridden.
function deleteEndpointUrl(): string | null {
  const explicit = process.env.OT_TRIBE_DELETE_ENDPOINT_URL;
  if (explicit) return explicit;
  const create = process.env.OT_TRIBE_ENDPOINT_URL;
  if (!create) return null;
  return create.replace(/createPartnerTribe(\/?)$/, "deletePartnerTribe$1");
}

/** Pull the tribeId out of a stored invite link (…/t/<tribeId>). */
export function tribeIdFromLink(link: unknown): string | null {
  if (typeof link !== "string") return null;
  const m = link.match(/\/t\/([^/?#]+)/);
  return m ? m[1] : null;
}

/**
 * Delete an event's tribe (called when the host cancels the event). Best-effort:
 * the caller ignores failures so a cancel never blocks on Online Tribes. The OT
 * endpoint only deletes tribes the partner pipeline created (partnerSource guard).
 */
export async function deleteTribeForEvent(tribeId: string): Promise<DeleteTribeResult> {
  const url = deleteEndpointUrl();
  const secret = process.env.OT_TRIBE_SECRET;
  if (!url || !secret) return { ok: false, reason: "not_configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ tribeId }),
      signal: controller.signal,
    });
    if (res.status === 403) return { ok: false, reason: "not_partner" };
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[online-tribes] deletePartnerTribe ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, reason: "error" };
    }
    const json = (await res.json()) as { deleted?: boolean };
    return { ok: true, deleted: json.deleted === true };
  } catch (e) {
    console.error(`[online-tribes] deletePartnerTribe failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}
