# Product Brief — Founders & Builders @ VivaTech 2026

**Companion to:** [REQUIREMENTS.md](./REQUIREMENTS.md) (structural — screens, flows, fields).
**This doc:** what the product *feels* like. Read this before opening Figma.

---

## In one sentence

> **A private, hand-picked WhatsApp circle of ~100 founders, builders, and investors at VivaTech Paris 2026 — with a quiet website that handles the boring parts (signup, profiles, RSVPs) and a smart bot that helps the conversations and meetups actually happen.**

---

## What this is NOT (matters more than what it is)

- **NOT a networking app.** No leaderboards, no streaks, no badges, no LinkedIn-style "people you may know" carousels.
- **NOT a SaaS product.** No pricing page, no feature comparison table, no testimonial wall, no "trusted by" logo strip.
- **NOT a pitch / deal-flow surface.** No pitch deck uploads, no investor matching, no "raising $X" tags.
- **NOT a general AI chatbot.** The bot understands ~10 verbs and refuses everything else.
- **NOT a Luma / Meetup competitor.** Events exist but they're tiny (6–15 people), curated by the host, intimate.
- **NOT mass-market.** ~100 members for v1. Forever invite-only.

If a screen would feel at home on a typical YC startup landing page or a B2B SaaS dashboard, it's wrong for this product.

---

## Who's it for (concrete personas in your head)

Picture these three when designing:

1. **Léa, 31, founder.** Building a climate-fintech YC seed. In Paris from Berlin for VivaTech, three days, hates "networking events," really wants to meet two specific French VCs and find one technical co-founder. Will pay attention to the manifesto. Wants to be invited *because someone vouched for her*, not because she signed up to a list.

2. **Marcus, 44, investor.** Partner at a boutique European fund. At VivaTech to scout, but exhausted by 100 cold pitches a day on the floor. Will RSVP to a rooftop drinks because it's small and someone he trusts is going. Doesn't want his phone number anywhere public.

3. **Yuki, 27, builder-designer.** First-time founder, solo, doesn't know many people in Paris, slightly introverted. Will not approach Léa or Marcus on the floor. *Will* text the bot "I am alone" at 7pm and let it suggest a crew having dinner nearby.

The product wins if Léa, Marcus, and Yuki all feel like it's for *them specifically*. Yuki is the one the bot exists for.

---

## The feeling

If the website were a place, it would be:
- A **private members' club**, not a co-working space
- A **handwritten invitation card**, not a paid Eventbrite ticket
- A **dinner party host's WhatsApp**, not Slack
- A **bookstore café in the 6e arrondissement**, not a hotel lobby

Three adjectives that should describe every screen: **warm, curated, quiet.**

Three adjectives that should describe none: **slick, ambitious-looking, scaleable-feeling.**

---

## Three moments that define the product

If the design nails these three, everything else follows.

### Moment 1: The invitation lands

Léa is in a LinkedIn DM thread with Franek. He sends one short message ending with a link. She taps it on her phone.

She sees a **single sentence** in italic French at the top — *"Une petite circle of founders à Paris."* — then a serif headline that doesn't try to sell her anything. There's no signup-form, no email field, no scroll-to-features. Just one button: **Continue with LinkedIn**, and a quiet note that her invite code is recognized.

She thinks: *"Someone hand-picked me for this. This is not a list."*

The page should be **sub-second on first paint**, mobile-first, and feel like opening a letter, not landing on a marketing site.

### Moment 2: The AI interview ends

Léa has just had a 6-turn chat with a warm AI host. It asked one question at a time, listened, and asked good follow-ups. At the end it shows a **summary card** — *"Here's what I heard about you"* — with the few sentences it'll show to other members.

She has the option to edit any of them. She thinks: *"This understood me better than the LinkedIn 'about' section I never update."*

The design should make the interview feel like a quiet conversation in chat, not a multi-page form. Suggestion chips for one-tap replies. A thin progress bar. The AI's avatar is subtle — not a robot, not a Memoji, maybe just a small soft circle.

### Moment 3: The bot makes the intro happen

It's 7:42pm. Yuki is sitting alone at a hotel bar near Porte de Versailles. He texts the WhatsApp bot: *"I am alone."*

The bot replies in ~5 seconds:

> *"Hey Yuki. 4 founders are at Café Marly for drinks right now — Léa (climate fintech), Tom (AI dev tools), Ana (consumer), Jules (deep tech). They're loose, no agenda. Want me to introduce you?"*

Yuki types: *"yes"*

A 5-person WhatsApp group appears on his phone, named "Café Marly drinks." The bot has posted a one-line intro that names what each person is building. Léa sends a wave emoji within 30 seconds.

The website never enters this moment. WhatsApp does the work. But the website is where Léa, Tom, Ana, and Jules built the profiles that made the bot's intro possible.

The design implication: **the website is a quiet enabler, not the destination**. Many screens deliberately push the user back to WhatsApp.

---

## Visual direction

### Palette (locked in code, change here if needed)

- **Background:** `#FAF7F2` — warm off-white, the color of unbleached paper
- **Ink:** `#1F1D1A` — near-black with a touch of warmth (not pure black)
- **Accent:** `#C9522B` — terracotta. Used sparingly — primary CTAs, hover states, the underline on links
- **Muted:** `#6E6962` — taupe-grey for secondary text

No corporate blue. No mint green. No Stripe-purple gradient. No dark mode in v1.

### Type

- **Headlines:** Fraunces (serif, variable, optical-size-aware). Tight letterspacing on large sizes. Conveys editorial / human / not-a-product.
- **Body & UI:** Inter (sans, 400/500/600). Clean and quiet, lets the serif headlines do the work.
- **Italic French line** appears as a recurring small motif in Fraunces italic.

Both are Google Fonts, free, available now.

### Imagery

- **Yes:** real photos of Paris (rooftops, cafés, narrow streets, Seine at dusk), photos Franek takes himself, line illustrations with character.
- **No:** stock photos of "diverse young professionals high-fiving", isometric vector illustrations of people networking, gradient meshes, generic conference-floor shots, anything that smells like a Notion template.
- **Hero image** is the most important visual in the whole product. It sets tone before the user reads a single word. Recommendation: one beautiful, slightly unexpected photograph (a quiet street, an empty café table set for two, a Seine bridge at golden hour). NOT a smiling person, NOT a crowd.

### Spacing & rhythm

- Generous whitespace. Aim for the feel of a magazine spread, not a dashboard.
- Single-column on mobile and tablet for almost everything. Multi-column grid only emerges on wide desktop and even then sparingly (directory grid, event cards).
- Max content width ~640–720px for reading surfaces (landing, manifesto, profile view).
- Cards have soft 12–16px radius, very subtle shadow (`0 1px 2px rgba(0,0,0,0.04)`) — not floating, just lifted off the page.

### Icons

- Line icons (`lucide` or similar) at consistent stroke weight. No filled icons except for status badges (RSVP confirmed, etc.).
- Event-kind icons should feel like **handwritten emoji** in spirit: ☕ coffee, 🥂 drinks, 🍳 breakfast, 🌇 rooftop, 🍝 dinner. Either actual emoji or custom monochrome marks in the same spirit.

---

## Voice & tone

The product talks like **Franek hosting a small dinner party**, not like a startup CEO and not like a corporate brand.

### Good

- *"You've been invited. Here's how to join."*
- *"Franek reviews each application personally — usually within 24 hours."*
- *"This door is invite-only — but if it's a fit, you'll hear from Franek on LinkedIn within a few days."*
- *"4 founders are at Café Marly. Want me to introduce you?"*
- *"You're off the list. Site access stays. Reply `start` to opt back in."*

### Bad

- *"Welcome to your VivaTech success journey!"* — sales energy, exclamation
- *"Unlock exclusive networking opportunities"* — corporate, "exclusive" is a tell
- *"AI-powered matchmaking for tomorrow's founders"* — feature marketing, future-bro
- *"Your account has been provisioned"* — enterprise software
- *"Tap to start your free trial"* — wrong product

### Microcopy rules

- Use full sentences, no Title Case Buttons. `Continue with LinkedIn`, not `Continue With LinkedIn`.
- Use "you," never "users."
- Empty states are first-person warmth: *"No events yet — Franek's cooking up the first one"*, not *"No data available."*
- Errors are kind: *"This code isn't recognized. Codes look like XXXX-XX — case-insensitive."*
- Rejection copy doesn't burn the bridge: *"Not a fit for this cohort — let's keep in touch on LinkedIn."*

---

## Constraints that shape design

These are non-negotiable; design around them, not against them:

1. **Invite-only forever.** No public signup CTA. The most prominent action on the public landing is *I have an invite code*, not *Apply*.
2. **WhatsApp-first.** Many screens have a small "Open in WhatsApp" affordance. The site is the quiet brain; the conversation lives elsewhere. Don't try to win attention back to the website.
3. **Phone numbers are sacred.** A member never sees another member's phone number. Intros happen via 3-person WhatsApp groups that Franek creates.
4. **Sub-second landing.** The public `/` page is static HTML, not the Flutter bundle. It must feel instant on a cold LinkedIn DM tap.
5. **Mobile-primary.** Most members will use this on their phone between sessions at VivaTech. Desktop is for the admin (Franek) and for occasional profile editing.
6. **Curated > scaleable.** Patterns like "infinite member directory" or "search the whole network" are wrong. 100 members fit on a few scrollable screens.
7. **Bot replies are constrained.** ≤280 chars, ≤2 emojis, ≤1 exclamation mark, no LinkedIn-bro phrasing. Designs that involve bot output (e.g., a screenshot of a WhatsApp thread) should follow this voice.
8. **Lives ~3 weeks in production then archives.** Don't design for a Year 2 alumni network now. Hooks exist; UI is for VivaTech 2026.

---

## What the designer should produce first

In rough order, the highest-leverage frames:

1. **Public Landing** (mobile + desktop) — the make-or-break first impression
2. **Auth screen** — the moment of "Sign in with LinkedIn" — single button, no clutter
3. **AI Profile Interview** — chat surface, suggestion chips, progress dots
4. **Welcome / Onboarding** — the WhatsApp join hand-off
5. **Member Home** — the daily landing surface
6. **Event Detail** with **Suggested Buddies** section embedded — the matching moment in UI form
7. **Admin Applications Inbox** — the screen Franek lives in
8. **The 404** — proves you got the voice right

Everything else flows from these eight.

---

## One more thing

If you imagine the product launching, Léa's tweet should be:

> *"My favorite thing about VivaTech wasn't VivaTech. It was the little group Franek pulled together. I met three people I'm staying close with."*

Design every screen as if she's about to write that tweet. Nothing on the screen should make her feel embarrassed to admit she was part of "the little group."
