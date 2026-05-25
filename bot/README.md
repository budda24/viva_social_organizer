# Bot — Laptop-hosted Claude Code brain

Long-running Node process that polls Firestore `botInbox`, spawns `claude -p` per message, and writes replies to `whatsappOutbox`.

```
WhatsApp user → Whapi.cloud → whapiWebhook (Cloud Function)
                                  ↓
                          Firestore botInbox
                                  ↓
                       this process (polls every 2s)
                                  ↓
                       spawn `claude -p <msg>` in this dir
                       (auto-loads ./CLAUDE.md as system prompt)
                                  ↓
                       Firestore whatsappOutbox
                                  ↓
                       onOutboxCreated (Cloud Function)
                                  ↓
                       Whapi.cloud → WhatsApp user
```

## Files

- [src/index.ts](src/index.ts) — polling loop, claim-and-process
- [src/brain.ts](src/brain.ts) — spawns `claude -p`, manages conversation history
- [src/inject.ts](src/inject.ts) — local test: drop a fake inbox row, read back the reply
- [CLAUDE.md](CLAUDE.md) — bot persona/rules (auto-loaded by `claude` when cwd = bot/)

## Prototype setup

### 1. Install + log in to the Claude Code CLI

The VSCode extension's binary isn't in `$PATH`. Install standalone:

```bash
npm install -g @anthropic-ai/claude-code
claude --version    # verify
claude              # one-time login (opens browser, uses your Claude subscription)
```

The bot brain spawns `claude -p` as a subprocess and inherits this login from `~/.claude/`. **No `ANTHROPIC_API_KEY` is needed** — usage counts against your Claude subscription rate limits.

> ⚠️ Anthropic's terms intend the subscription for personal use. Using it to serve many WhatsApp users (a product) is gray-area at best. Fine for personal/prototype; switch to the API for production.

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

Env vars consumed by [brain.ts](src/brain.ts):

| Var | Default | Purpose |
|---|---|---|
| `CLAUDE_BIN` | `claude` | Path to CLI, override if not in PATH |
| `CLAUDE_MODEL` | `claude-haiku-4-5` | Model passed via `--model` |
| `CLAUDE_TIMEOUT_MS` | `60000` | Kill claude if it hangs |
| `POLL_INTERVAL_MS` | `2000` | Inbox poll cadence |
| `BOT_HOST_ID` | `laptop-<rand>` | Recorded on claimed rows |

Claude auth is taken from the local `claude login` session in `~/.claude/`, not from any env var.

## What this prototype does NOT do yet

- **Tool use** — the bot only generates text. It can say "OK, I'll mark you free for 60 min" but doesn't actually write `freeUntil` to Firestore. To add real actions, either:
  - parse a structured response from Claude (e.g. JSON like `{reply, actions: [...]}`) and execute in [brain.ts](src/brain.ts), or
  - run a custom MCP server exposing `writeFreeUntil`, `readUser`, etc. and register it with the spawned `claude` via `--mcp-config`.
- **Auth scoping** — every `claude` invocation uses the laptop user's local `claude login` (the same account you use in VSCode). Every WhatsApp user's message hits your one Claude subscription.
- **Multi-user concurrency caps** — current poll loop processes one message at a time. For a real event with 100+ members, raise the parallelism in [src/index.ts](src/index.ts).
