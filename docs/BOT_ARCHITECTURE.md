# Viva Tribu Bot — Architecture & Decisions

Snapshot of the dual-channel matching bot built for VivaTech Paris 2026 (~June). This document captures what's live, what's decided but not yet built, and why.

Last updated: 2026-05-25

---

## TL;DR

- **Dual channel**: Telegram (primary, free) + Twilio WhatsApp Sandbox (fallback, free for the event).
- **Brain**: Node.js process (today on Franek's laptop, target VPS), polls Firestore queues, calls Claude per message.
- **Identity & onboarding**: 2 scripted questions captured live; the rest of the profile filled by async web-search enrichment.
- **Runtime, target state**: Claude Haiku 4.5 via Anthropic SDK with prompt caching. (Currently runs through `claude` CLI subprocess — confirmed bottleneck, migration scheduled.)
- **Stress test result (2026-05-25)**: 10 concurrent messages → 3 done, 7 failed at Anthropic Tier 1's 50K input-TPM cap. Confirmed the API+tier upgrade is the binding constraint, not the laptop.

---

## Planned runtime (target state — committed direction)

> **We plan to use the Claude Haiku 4.5 API as our API/SDK worker target.**
> **Price: approximately $1 / 1M input tokens and $5 / 1M output tokens.**

This replaces the current `claude` CLI subprocess approach. Migration is in flight (see Phase A in the migration plan below). Once shipped:

- Each bot worker process calls `anthropic.messages.create({...})` directly using the Anthropic Node SDK.
- The same Haiku 4.5 model serves both the chat brain and the async enrichment worker.
- Prompt caching is enabled on the system prompt + member directory (cached reads cost ~10% of normal, refreshed every 5 min).
- Bot workers run anywhere with an `ANTHROPIC_API_KEY` env var: laptop, VPS, container, multiple instances in parallel. No Claude subscription dependency, no subprocess spawn cost per message.
- All cost projections below assume this runtime.

---

## Development & validation methodology

**Build carefully, then prove it with the load test.** Every change to the brain runtime — SDK migration, caching, 429 backoff, per-uid lock, anything that touches `processMessage` or the worker loop — must end with a green run of [`bot/src/load-test.ts`](../bot/src/load-test.ts) before we call it shipped.

### Canonical acceptance test

```bash
# 1. Brain running with target concurrency
MAX_CONCURRENT=15 npm run dev

# 2. Stress-test escalation (in another terminal)
npx tsx bot/src/load-test.ts --count 10 --cleanup    # warm-up; must be green
npx tsx bot/src/load-test.ts --count 25 --cleanup    # realistic burst
npx tsx bot/src/load-test.ts --count 50 --cleanup    # heavy burst
npx tsx bot/src/load-test.ts --count 100 --cleanup   # 1000-user-day peak
```

### Pass criteria after the SDK migration

- `failed == 0` at `--count 50`
- `effective parallelism >= MAX_CONCURRENT * 0.8` (i.e. workers actually run in parallel, not serialized by 429s)
- `per-message max < 15s` (no requests stuck behind rate-limit queues)
- `throughput >= 150 msg/min` at `MAX_CONCURRENT=15`

### Baseline (pre-migration, 2026-05-25)

At `--count 10` we observed: 3 done / 7 failed, 2 of which were API 429s and 5 timed out behind the rate-limit queue. **Reproducing this and watching it become 10/10 done is the proof the migration actually fixed the binding constraint.**

> Treat the load test as the regression gate. If a change can't prove itself here, it doesn't ship.

---

## System diagram

```
                   ┌──────────────────────────────┐
                   │   Landing page               │
                   │   viva-tribe.online-tribes   │
                   │   - LinkedIn sign-in (Phase 2)
                   │   - "Open in Telegram" CTA   │
                   │   - "Don't have Telegram?"   │
                   │     → WhatsApp fallback      │
                   └──────────────┬───────────────┘
                                  │
                ┌─────────────────┴─────────────────┐
                ▼                                   ▼
        ┌───────────────┐                   ┌───────────────┐
        │  Telegram     │                   │  WhatsApp     │
        │  @VivaTribuBot│                   │  Twilio       │
        │               │                   │  Sandbox      │
        └───────┬───────┘                   └───────┬───────┘
                │                                   │
                ▼                                   ▼
   ┌────────────────────────┐         ┌─────────────────────────┐
   │ Cloud Function:        │         │ Cloud Function:         │
   │ telegramWebhook        │         │ twilioWebhook           │
   │ - secret-token check   │         │ - X-Twilio-Signature    │
   │ - /start invite bind   │         │ - identity by phone     │
   │ - identity by chatId   │         │ - rate limit (5/m, 50/h)│
   │ - rate limit (20/m)    │         │ - write botInbox        │
   │ - write botInbox       │         │                         │
   └───────────┬────────────┘         └────────────┬────────────┘
               │                                   │
               └───────────────┬───────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │  Firestore: botInbox │ ◄──┐
                    │  (provider, uid, body)│   │ reclaim
                    └──────────┬───────────┘    │ stale leases
                               │                │ (Cloud Function,
                               ▼                │  every 1 min)
        ┌────────────────────────────────────┐  │
        │  Brain (Node process, laptop/VPS)  │──┘
        │   - poll botInbox, lease-claim     │
        │   - onboarding gate (2 questions)  │
        │   - inject member directory        │
        │   - spawn `claude -p` (→ migrate   │
        │     to Anthropic SDK)              │
        │   - write whatsappOutbox           │
        │   - second loop: enrichment jobs   │
        │     (claude -p + WebSearch)        │
        └──────────────────────┬─────────────┘
                               ▼
                ┌──────────────────────────────┐
                │  Firestore: whatsappOutbox   │
                └──────┬───────────┬───────────┘
                       │           │
                       ▼           ▼
            ┌──────────────┐  ┌──────────────────┐
            │ onTelegram   │  │ onTwilio         │
            │ OutboxCreated│  │ OutboxCreated    │
            │ → Telegram   │  │ → Twilio API     │
            │   Bot API    │  │                  │
            └──────────────┘  └──────────────────┘
```

---

## Components

### Channel adapters — `functions/src/channels/`

| File | Role |
|---|---|
| [`types.ts`](../functions/src/channels/types.ts) | Shared `ChannelId`, `InboxRow`, `OutboxRow` types |
| [`identity.ts`](../functions/src/channels/identity.ts) | `resolveUserByChannel(channel, phone-or-chatId)` → uid |
| [`rateLimit.ts`](../functions/src/channels/rateLimit.ts) | Per-(channel, uid) sliding-window counter in Firestore |
| [`twilio/webhook.ts`](../functions/src/channels/twilio/webhook.ts) | X-Twilio-Signature check, identity, rate-limit, write inbox |
| [`twilio/outbox.ts`](../functions/src/channels/twilio/outbox.ts) | Fires on outbox rows where `provider=twilio`, sends via Twilio |
| [`telegram/webhook.ts`](../functions/src/channels/telegram/webhook.ts) | Secret-token check, `/start <inviteCode>` binding, write inbox |
| [`telegram/outbox.ts`](../functions/src/channels/telegram/outbox.ts) | Fires on outbox rows where `provider=telegram`, sends via Telegram Bot API |

Dispatch is via the `provider` field on each Firestore row. The brain itself is channel-agnostic.

### Brain — `bot/src/`

| File | Role |
|---|---|
| [`index.ts`](../bot/src/index.ts) | Polling loops (inbox + enrichment), lease management, heartbeat, concurrency via `MAX_CONCURRENT` |
| [`brain.ts`](../bot/src/brain.ts) | `processMessage()` — load context, run onboarding gate, build context block, spawn Claude, write outbox |
| [`onboarding.ts`](../bot/src/onboarding.ts) | 2-question state machine: `pending → ask_goal → ask_energy → complete` |
| [`enrich.ts`](../bot/src/enrich.ts) | Async worker: poll `users` where `enrichment.status="pending"`, spawn `claude -p` with WebSearch, save synthesized JSON profile |
| [`seed-telegram.ts`](../bot/src/seed-telegram.ts) | Manual user seeding for testing |
| [`seed-test-users.ts`](../bot/src/seed-test-users.ts) | Seed 7 fake members (Marcus, Léa, etc.) for matching tests |
| [`queue-enrichment.ts`](../bot/src/queue-enrichment.ts) | Manually queue an enrichment job (simulates LinkedIn signin) |
| [`load-test.ts`](../bot/src/load-test.ts) | Synthetic-user stress test (up to 200 concurrent inbox rows) |

### Other Cloud Functions — `functions/src/`

- [`bot/reclaimInbox.ts`](../functions/src/bot/reclaimInbox.ts) — every minute, resets `processing` rows whose lease expired
- [`invites/redeem.ts`](../functions/src/invites/redeem.ts) — invite code redemption (web side)

---

## Firestore data model

### `users/{uid}`
```
displayName, email, photoUrl, role, status (invited|approved|opted_out)

// Channel binding (one or both)
whatsappPhoneE164, telegramChatId, telegramUsername, telegramBoundAt

// Asked during onboarding (2 questions only)
goal:    string         // "meet European AI VCs"
energy:  "1on1" | "group" | "both"

// Background enrichment (Phase 2 + always async)
linkedinHeadline, linkedinId
enrichment: {
  status: "pending" | "running" | "complete" | "failed"
  bio, topics[], company, recentActivity, matchSignals
  startedAt, completedAt, leasedBy, attempts, lastError
}

// Onboarding state machine
onboarding: { step, startedAt, completedAt }

// Test data flag (load-test, seed-test-users)
isLoadTest: true
```

### `botInbox/{messageId}`
```
messageId, provider ("twilio"|"telegram"), uid, body
phone? (twilio) | chatId? (telegram) | profileName? | tgUsername?
status: "pending" | "processing" | "done" | "failed"
attempts, receivedAt, leasedBy, leaseExpiresAt, lastError
```

### `whatsappOutbox/{id}`
> Name is a misnomer — also carries Telegram. Don't rename mid-event; rename post-VivaTech.
```
provider, recipientUid, body, type, status, attempts
recipientPhone? (twilio) | recipientChatId? (telegram)
createdAt, sentAt, providerMessageSid, lastError
```

### `rateLimit/{channel}_{uid}`
```
channel, uid, minuteStart, hourStart, minuteCount, hourCount, updatedAt
```

### `conversationStates/{uid}`
```
uid, turns: [{role, content, at}], updatedAt
```
> Capped at last 12 turns (HISTORY_LIMIT * 2). Keyed by uid (channel-agnostic).

### `inviteCodes/{code}`
```
code (VIVA-XXXX-XX), maxUses, uses, usedBy[], expiresAt, disabled
```

### `system/botHeartbeat`
```
hostId, lastSeenAt, inFlight, maxConcurrent, version
```

---

## Key decisions & rationale

### 1. Telegram primary, Twilio Sandbox WhatsApp fallback
- **Why**: Telegram is free + zero friction (no join code). WhatsApp gives broader reach but Twilio Sandbox has bad UX (mandatory `join test-disappear` to a shared US number). Production Twilio (~$150-400 for event) was rejected: Meta approval takes 1-2 weeks, too tight before the event.
- **Hidden WhatsApp** behind "Don't have Telegram?" disclosure on landing page — only ~10-15% of users see the friction.
- **Rejected: Baileys / OpenClaw** (unofficial WhatsApp Web): library is 5+ months stale, Meta actively blocking AI bots in 2026, typical lifespan 2-8 weeks overlaps event window. Ban risk catastrophic.

### 2. 2-question onboarding, NOT 3
- **Why**: After deciding to do async enrichment (see #4), only intent-shaped questions remain — bio/topics/company are findable on the web, goal and energy aren't.
- Q1: "What's your goal at VivaTech?" (e.g. "meet European AI VCs")
- Q2: Energy preference: `1on1` / `group` / `both`
- Deterministic state machine, no Claude in the loop — predictable, free, fast.

### 3. Async enrichment with `claude -p` + WebSearch
- **Why "async"**: User doesn't wait. They onboard on Telegram in <30s; enrichment fills in background (5-15s).
- **Why `claude -p` (not Tavily + Anthropic SDK)**: subscription was already paid, WebSearch tool built into the CLI does both research and synthesis in one call. Zero new keys, zero per-search cost.
- **Status**: works today on subscription. Will move to Anthropic SDK alongside the chat brain (see #5).

### 4. Channel adapters split by transport
- `functions/src/channels/{twilio,telegram}/{webhook,outbox}.ts` per channel.
- Brain stays transport-agnostic — reads `botInbox`, writes `whatsappOutbox`, dispatch via `provider` field.
- Adding a third channel (Signal, iMessage, in-app chat) = one new folder, no brain changes.

### 5. **PLANNED — Claude Haiku 4.5 API via Anthropic SDK is the worker runtime**
- **Date decided**: 2026-05-25 (this session)
- **Direction**: We plan to use the **Claude Haiku 4.5 API** as our API/SDK worker target, priced at approximately **$1 / 1M input tokens and $5 / 1M output tokens**.
- **Replaces**: the current `claude` CLI subprocess approach (gray-area subscription use, Tier-1-locked, blocking us at 50K TPM).
- **Why**:
  - Subscription is gray-area for serving many users
  - Tier 1 cap (50K input TPM) blocks 10+ concurrent messages — confirmed by load test on 2026-05-25
  - SDK enables prompt caching → ~5× effective TPM headroom
  - SDK avoids 100-300ms subprocess spawn cost per message
  - Workers can run anywhere with `ANTHROPIC_API_KEY` — no local Claude install dependency
- **Same model for enrichment**: Haiku 4.5 (cheap, web search synthesis is not Sonnet-grade work). Enrichment worker also moves to SDK with the server-side WebSearch tool.
- **Status**: not yet built. Next major work item (Phase A in the migration plan).

### 6. Per-user serialization for multi-worker scaling
- **Decided shape**: stay on Firestore queue + add per-uid uniqueness gate in `claimOne` (don't claim a message if its uid already has one in flight anywhere).
- **Rejected for now**: Inngest, Trigger.dev — bringing in a new vendor 10 days before the event is the wrong risk. Right answer for v2.
- **Why per-uid lock matters**: prevents onboarding-state races (two workers reading `step="ask_goal"` and both saving the user's first message as their goal answer).

### 7. Rate limiting at the webhook
- Per `(channel, uid)` sliding-window counter in Firestore.
- WhatsApp: 5 msgs/min, 50/hr per user. Telegram: 20 msgs/min, 200/hr.
- Blocked → 200 OK + drop. No reply (avoids spammy back-and-forth).

### 8. Member directory injection
- Brain loads ALL approved users on every message, injects into context.
- **Knowingly inefficient at scale**: works fine for <100 members, becomes the biggest input-token line item at 100+.
- **Planned**: pre-filter to ~10 relevant members per query once user count grows. Deferred until after VivaTech.

---

## Cost model

Pricing assumed: **Claude Haiku 4.5 — $1/M input, $5/M output** (per Anthropic 2026 list price).

### Per-call token sizes (measured/estimated)

| Component | Tokens |
|---|---|
| System prompt (CLAUDE.md) | ~1,500 |
| Member directory (current, 7-17 members) | ~2,500 |
| Member directory (full event, 100 members) | ~10,000 |
| Context block (uid, channel, history, self) | ~500 |
| User message | ~50 |
| Total **per chat message, today** | **~4,500** input + ~200 output |
| Total **per chat message, at 100 members** | **~12,000** input + ~200 output |

### Cost per chat message (Haiku 4.5)

| Scenario | Input cost | Output cost | **Total** |
|---|---|---|---|
| Today, no caching | 4,500 × $1/M = $0.0045 | 200 × $5/M = $0.001 | **$0.0055** |
| Today, with prompt caching (90% hit) | 0.1 × $0.0045 + $0.0001 fresh ≈ $0.0006 | $0.001 | **$0.0016** |
| Full event (100 members), no caching | 12,000 × $1/M = $0.012 | $0.001 | **$0.013** |
| Full event, with caching | 0.1 × $0.012 + $0.0002 fresh ≈ $0.0014 | $0.001 | **$0.0024** |

> Prompt caching: anything marked `cache_control: ephemeral` is stored 5 min and re-reads cost 10% of normal. System prompt + member directory are identical across requests → ideal candidates.

### Cost per enrichment (Haiku 4.5 + WebSearch)

| Component | Tokens |
|---|---|
| Per-enrichment prompt + search results | ~30,000 input |
| Synthesized JSON output | ~1,000 |

= 30,000 × $1/M + 1,000 × $5/M = **$0.035 per enrichment**

### Projected event costs

Assumes 1,000 VivaTech attendees, "talking a little" (~8 messages/user across event).

| Item | Volume | Unit cost | **Subtotal** |
|---|---|---|---|
| Enrichments (one per signed-up user) | 1,000 | $0.035 | **$35** |
| Chat messages, with caching | 8,000 | $0.0024 | **$19** |
| Chat messages, without caching (worst case) | 8,000 | $0.013 | $104 |
| **Total event (with caching)** | | | **~$54** |
| **Total event (no caching, worst case)** | | | **~$140** |

For a 3-day flagship event with ~1,000 attendees, **the ceiling is ~$140 and the realistic number with caching is ~$54.** Trivial compared to the migration risk avoided.

### Steady-state ongoing (post-VivaTech, if product continues)

100 active users × 30 messages/month × $0.0024 (with caching) = **~$7/month** + occasional enrichment for new signups.

---

## Capacity & throughput

### Anthropic rate limits (input tokens per minute)

| Tier | TPM | $ to advance | How long to reach |
|---|---|---|---|
| 1 (current) | 50,000 | $0 | n/a |
| 2 | 100,000 | $5 deposit | immediate |
| 3 | 400,000 | $40 total deposit | 7 days account age |
| 4 | 2,000,000 | $200 total deposit | 14 days account age |

### What each tier can handle (with caching, ~500 effective input TPM per chat message)

| Tier | Chat throughput | Verdict |
|---|---|---|
| 1 (50K TPM) | ~100 msg/min | Tight for 1000 users at peak burst |
| **2 (100K TPM)** | **~200 msg/min** | **Adequate for VivaTech** |
| 3 (400K TPM) | ~800 msg/min | Comfortable headroom |

### Recommended target

- **Top up to Tier 2 minimum** ($5 deposit) before any meaningful testing.
- Tier 3 ($40 deposit, needs 7-day account age) is the comfortable target for VivaTech. Start the deposit clock now.

---

## Migration plan (the work still to do)

### Phase A — runtime swap (~1 day, blocks all scale work)

- [ ] Replace `spawn("claude", ...)` in [`brain.ts`](../bot/src/brain.ts) with `anthropic.messages.create()`
- [ ] Add `ANTHROPIC_API_KEY` to bot `.env`
- [ ] Add prompt caching headers on system prompt + member directory
- [ ] Same in [`enrich.ts`](../bot/src/enrich.ts) — use SDK with WebSearch tool (server-side tool, available in API)
- [ ] Add 429 backoff: on rate-limit error, sleep with jitter and retry (don't fail message)
- [ ] **Acceptance gate**: [`load-test.ts`](../bot/src/load-test.ts) at `--count 50` returns 0 failures, ≥150 msg/min, max latency <15s (see Development & validation methodology section)

### Phase B — multi-worker safety (~2 hours)

- [ ] Add per-uid uniqueness gate to `claimOne` (Firestore transaction checks `users/{uid}.activeMessageId`)
- [ ] Clear `activeMessageId` on completion
- [ ] Per-worker heartbeat: `system/workers/{hostId}` doc, refreshed every 15s
- [ ] Graceful shutdown: SIGTERM/SIGINT drains in-flight before exit
- [ ] **Acceptance gate**: launch 2 workers (`BOT_HOST_ID=w1` and `=w2`) on the same Firestore; run `load-test.ts --count 50`; same-uid messages never overlap, throughput ~2x single-worker

### Phase C — VPS deployment (~half day)

- [ ] Provision Hetzner CX11 (€4/mo) or DO $6 droplet
- [ ] Install Node 20, claude-code (for enrichment until SDK swap is done for it too)
- [ ] PM2 process manager + auto-restart
- [ ] Run 2-3 workers from same machine
- [ ] Set BOT_HOST_ID per worker

### Phase D (deferred to post-event) — Phase 2 LinkedIn

- [ ] Firebase Identity Platform OIDC config for LinkedIn
- [ ] LinkedIn Developer App
- [ ] Flutter LinkedIn sign-in flow on landing page
- [ ] Callable Cloud Function `markEnrichmentPending` invoked by Flutter post-signin
- [ ] GDPR consent text

### Phase E (post-event polish)

- [ ] Rename `whatsappOutbox` → `messageOutbox`
- [ ] Pre-filter member directory injection (only ~10 relevant per query)
- [ ] Move to Inngest or Trigger.dev for proper workflow orchestration (if scaling further)
- [ ] Move enrichment to Anthropic API directly (drop CLI dependency entirely)

---

## Open questions

1. **VPS provider**: Hetzner (cheapest, EU-located, good for VivaTech latency) vs DigitalOcean (most familiar) vs Google Cloud Run (auto-scales, more expensive). Default = Hetzner CX11.
2. **Landing page source of truth**: repo's `landing/index.html` vs `viva-tribe.online-tribes.com` (shown in mockups) — which gets the Telegram CTA added?
3. **Phase 2 timeline**: LinkedIn enrichment ships before or after VivaTech?
4. **Post-event direction**: keep the bot running as a year-round community tool, or shut it down after VivaTech?

---

## Test surface

| Test | Command |
|---|---|
| Local injection (no real channel) | `npx tsx bot/src/inject.ts --uid <uid> --phone +... --body "..."` |
| Seed test members for matching | `npx tsx bot/src/seed-test-users.ts` |
| Bind Telegram chat manually | `npx tsx bot/src/seed-telegram.ts --uid <uid> --chatId <num>` |
| Queue an enrichment (fakes LinkedIn) | `npx tsx bot/src/queue-enrichment.ts --uid <uid> --name "..." --email ... --headline "..."` |
| Stress test brain | `npx tsx bot/src/load-test.ts --count 50 --cleanup` |
| Cleanup leftover test docs | `npx tsx bot/src/load-test.ts --cleanup-only` |

---

## Related docs

- [`PRODUCT_BRIEF.md`](./PRODUCT_BRIEF.md) — product vision
- [`REQUIREMENTS.md`](./REQUIREMENTS.md) — requirements doc
- [`bot/CLAUDE.md`](../bot/CLAUDE.md) — Tribu persona / system prompt
- [`bot/README.md`](../bot/README.md) — bot setup guide
