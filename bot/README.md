# Bot — Laptop-hosted Claude brain

Long-running Node process that polls Firestore `botInbox`, calls the **Claude Agent SDK** in-process per message, and writes replies to `whatsappOutbox`.

```
User (Telegram / WhatsApp) → channel webhook (Cloud Function)
                                  ↓
                          Firestore botInbox
                                  ↓
                       this process (polls every 2s, MAX_CONCURRENT in flight)
                                  ↓
                       Claude Agent SDK query()
                       (CLAUDE.md loaded once at start as systemPrompt,
                        per-call context block appended)
                                  ↓
                       Firestore whatsappOutbox
                                  ↓
                       onTelegramOutboxCreated / onTwilioOutboxCreated
                                  ↓
                       Telegram Bot API / Twilio → user
```

## Files

- [src/index.ts](src/index.ts) — polling loop, parallel claim-and-process, heartbeat
- [src/brain.ts](src/brain.ts) — Agent SDK call, context building, outbox write
- [CLAUDE.md](CLAUDE.md) — bot persona/rules, loaded once and passed as systemPrompt
- [src/inject.ts](src/inject.ts) — local test: drop a fake inbox row, read back the reply
- [src/onboarding.ts](src/onboarding.ts) — deterministic 3-question onboarding gate
- [src/enrich.ts](src/enrich.ts) — async LinkedIn-style enrichment worker (still uses `claude -p` for WebSearch tool)

## Prototype setup

### 1. Claude auth

The Agent SDK reads, in order:

1. `ANTHROPIC_API_KEY` env var (paid API, prompt-caching available, no per-account rate limits — recommended for real load)
2. Claude Code OAuth from `~/.claude/` (your subscription — log in once with `claude login` after installing `@anthropic-ai/claude-code` globally)

**No env change needed if you've already done `claude login`** — the SDK picks it up automatically. Subscription usage counts against your Max plan rate limits.

> ⚠️ Anthropic's terms intend the subscription for personal use. Fine for prototype/personal; switch to API key + prompt caching for multi-user serving.
>
> The async enrichment worker ([src/enrich.ts](src/enrich.ts)) still spawns the `claude -p` CLI because it uses the built-in WebSearch tool. It needs the CLI installed and logged in. The chat brain itself doesn't.

### 2. Set up Firebase credentials

Create `.env` in the **project root** for the Firebase Admin SDK (used by the polling brain to read/write Firestore — separate from Claude):

```bash
cp .env.example .env
# Required:
#   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
#   FIREBASE_PROJECT_ID=<your-project-id>
# The ANTHROPIC_API_KEY line in .env.example is unused by this prototype — leave blank.
```

Get the service account JSON from Firebase Console → Project Settings → Service Accounts → Generate new private key. Drop the file at the path above.

### 3. Install bot deps and run

```bash
cd bot
npm install
npm run dev      # tsx watch — logs every claim/process
```

### 4. Verify with local injection (no WhatsApp needed)

In another terminal:

```bash
cd bot
npx tsx src/inject.ts --uid <real-user-uid> --phone +33600000000 --body "help"
```

You need a `users/{uid}` doc in Firestore with `status: "approved"`. The injector writes a fake `botInbox/inject-<ts>` row; the running brain claims it, spawns `claude -p`, and writes the reply to `whatsappOutbox`. The script prints the reply when it lands.

Try:
- `--body "help"` — should list capabilities
- `--body "free now"` — should acknowledge (no real freeUntil write yet — that's a v2 tool)
- `--body "stop"` — should confirm opt-out

### 5. Wire end-to-end through real WhatsApp

You have two options. **Twilio Sandbox** is what we'll use for first-test (free, ~5 min). **Whapi** is better long-term but slower to set up.

#### Option A — Twilio WhatsApp Sandbox (recommended for first test)

Free, shared sandbox number, no SIM/eSIM needed. Anyone you give the join code can talk to your bot.

1. Sign up at [console.twilio.com](https://console.twilio.com) (free trial includes credits).
2. Console → **Messaging → Try it out → Send a WhatsApp message**. You'll see:
   - A sandbox number, e.g. `+1 415 523 8886`
   - A join code, e.g. `join autumn-pinecone`
3. **Update [landing/index.html](../landing/index.html)** — replace `TWILIO_SANDBOX_NUMBER` with the digits-only number (`14155238886`) and `TWILIO_SANDBOX_JOIN_CODE` with the join code (e.g. `autumn-pinecone`). The button will then deep-link directly into "send `join autumn-pinecone` to the sandbox number".
4. **Save the Twilio creds** for the webhook (we'll wire these next iteration):
   ```
   TWILIO_ACCOUNT_SID=ACxxxxxxxx
   TWILIO_AUTH_TOKEN=xxxxxxxx
   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
   ```
5. Tell me when you have those — I'll add `functions/src/bot/twilioWebhook.ts` (parses Twilio's incoming-message shape into the existing `botInbox` schema), a Twilio-format `outbox` sender alongside the existing Whapi one, and the deploy steps. The brain itself doesn't change.

#### Option B — Whapi.cloud (Whapi for production, later)

1. **Whapi.cloud account** → create channel → link a dedicated WhatsApp number (eSIM, NOT your personal number — Whapi uses unofficial WhatsApp Web, your number can get banned). Save the channel token.

2. **Set Firebase secrets:**
   ```bash
   firebase functions:secrets:set WHAPI_TOKEN
   firebase functions:secrets:set WHAPI_WEBHOOK_SECRET   # any random string; you'll paste it into Whapi dashboard too
   ```

3. **Deploy functions:**
   ```bash
   cd functions && npm install && npm run build
   firebase deploy --only functions
   ```
   Note the deployed URL of `whapiWebhook` from the output.

4. **Configure Whapi webhook** — Whapi dashboard → channel settings → webhook URL = the deployed `whapiWebhook` URL, secret = the `WHAPI_WEBHOOK_SECRET` value from step 2.

5. **Create an approved user** — Firestore `users/{uid}` doc with:
   ```
   whatsappPhoneE164: "+33600000000"   // YOUR test phone in E.164
   status: "approved"
   displayName: "Test User"
   consentWhatsappMessages: true
   ```

6. **Run the brain** on your laptop:
   ```bash
   cd bot && bash run.sh   # caffeinate + auto-restart wrapper
   ```

7. **Message your Whapi number from your phone.** You should see:
   - `botInbox/{messageId}` appear (webhook)
   - Bot logs `[bot] processed ...`
   - `whatsappOutbox/...` appear with status `queued` → `sent`
   - WhatsApp reply on your phone

## Knobs

Env vars consumed by [brain.ts](src/brain.ts) + [index.ts](src/index.ts):

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (unset) | Optional. If set, Agent SDK uses API auth instead of OAuth |
| `CLAUDE_MODEL` | `claude-haiku-4-5` | Model passed to Agent SDK |
| `POLL_INTERVAL_MS` | `2000` | Inbox poll cadence |
| `MAX_CONCURRENT` | `5` | Max messages processed in parallel by one host |
| `BOT_HOST_ID` | `laptop-<rand>` | Recorded on claimed rows + heartbeat |

## What this prototype does NOT do yet

- **Tool use** — Agent SDK runs with `allowedTools: []`, so Claude only generates text. To let it call Firestore directly, set `allowedTools` and register MCP tools in the `query()` call.
- **Prompt caching** — system prompt + member directory are identical across requests and ideal for caching, but not wired up yet. Required before serving 10+ concurrent users (see [docs/BOT_ARCHITECTURE.md](../docs/BOT_ARCHITECTURE.md) capacity table).
- **Auth scoping** — when using OAuth, every user's message hits your one Claude subscription. Set `ANTHROPIC_API_KEY` to use the paid API for production.
