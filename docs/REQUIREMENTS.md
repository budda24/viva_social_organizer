# Requirements & User Paths — Founders & Builders @ VivaTech 2026

**Audience:** designer / Franek doing Figma.
**Source of truth for implementation:** `/home/franek/.claude/plans/becoming-the-organizer-of-spicy-charm.md`.

---

## 1. Product in one paragraph

An **invite-only** member portal + WhatsApp command bot for ~100 hand-picked founders, builders, and investors at VivaTech Paris 2026. The website is the **formal layer** — signup, profiles, events, RSVP, admin, code of conduct. WhatsApp is the **fast layer** — members shout commands ("beer tonight", "free now", "intro me"), the bot acts. Tone: warm private founder circle. Anti-tone: SaaS, sales funnel, networking app.

**Tagline:** *"Technology evolves fast. Human connection matters even more."*

---

## 2. Personas & access

| Role | Entry | What they can do | What they cannot |
| --- | --- | --- | --- |
| **Visitor** | Lands on `/` from a share | Read landing + manifesto, request consideration | See directory, events, RSVP |
| **Applicant** | Has an invite code from Franek's LinkedIn DM | Sign in with LinkedIn, redeem code, fill application, complete AI interview, view "pending review" | See members or events |
| **Member** | Approved by Franek | Browse directory, RSVP to events, see buddy suggestions, mark "Free now", request intros, use WhatsApp bot | Approve others, send blasts, create events |
| **Admin** (Franek, optional co-host) | Custom Firebase auth claim | Everything Members can do + applications inbox, event CRUD, blast composer, invite-code management, soft-remove members | — |

Auth: **LinkedIn OIDC only.** No Google, no email-link fallback in v1. Anyone in this community already has LinkedIn.

---

## 3. End-to-end user paths

### Path A — The golden path: invited → member

1. Franek DMs a curated LinkedIn lead with a code-bearing link: `https://[domain]/?c=VIVA-7K2P-XQ`
2. Lead clicks → **Landing (invited variant)** — hero says *"You've been invited"*, code pre-filled
3. Tap **Continue** → **Sign in with LinkedIn** (single button, OIDC) → name, email, photo auto-pulled
4. **Application Form** — 5–7 fields max, single screen with stepper indicator
5. **AI Profile Interview** — 6–8 turn chat with a warm-host AI. Suggestion chips for quick replies. Progress dots. Skip affordance.
6. **Application Pending** — "Franek personally reviews each application, usually within 24h."
7. *Out of band:* Franek opens admin, reviews, approves
8. Approved member opens any link → **Welcome / Onboarding**: WhatsApp group join button (huge, WhatsApp-green), code of conduct accept checkbox, "three things you can do now" card
9. Lands on **Member Home**

### Path B — Returning member daily loop

1. Sign in → **Member Home**: next event card with RSVP status, suggested buddies, "new in the circle", pinned host note, **Free now toggle** in header, **Find a crew** card
2. Tap **Directory** → searchable / filterable grid of members
3. Tap a member → **Member Profile (view)**: photo, headline, what they're building, what they're looking for, days at Viva, languages, fun fact, CTAs *Request intro via Franek* and *Open LinkedIn*
4. Tap **Events** → list of upcoming micro-events
5. Tap an event → **Event Detail**: hero, description, time, location (address only after RSVP), attendee avatars, **RSVP** button, then **Suggested buddies at this event** section appears, .ics download
6. Tap **Introduce us** on a buddy → confirmation modal → bot creates a 3-person WhatsApp group with an AI-drafted opener
7. Tap **Free now** in header → choose 15min/1h/today → small list of others currently free → tap "want coffee?" → AI-drafted DM goes out via Whapi

### Path C — Admin daily ops (Franek)

1. **Admin Dashboard** — 4 stat cards (pending applications, total members, next-event RSVPs, WhatsApp group count)
2. **Applications Inbox** — rich cards with LinkedIn photo + headline + interview transcript collapsed + AI **curation score 0–100** + 1-sentence rationale. Actions: Approve / Reject / Ask for more info
3. **Events Admin** — create/edit, fields per §5, toggle "Announce on WhatsApp on save?" + "Reminder 24h before?"
4. **Blast Composer** *(should-ship)* — audience selector, **Draft with AI** button + template picker, preview, send with double-confirm
5. **Member Admin** *(should-ship)* — search, soft-remove, change role

### Path D — WhatsApp commands (fast layer, runs in parallel to the website)

Closed vocabulary — bot understands these verbs only. Everything else: *"I only do a small set of things — try `help`."*

| Command examples | What happens |
| --- | --- |
| `beer tonight`, `drinks at 8` | Bot finds existing drinks events tonight or proposes a new one + matched members, asks for `yes` to confirm |
| `breakfast tomorrow`, `coffee at 9` | Same flow for breakfast/coffee |
| `dinner tomorrow` | Same flow for dinner |
| `free now`, `free for 1h` | Sets your `freeUntil`, returns 3 best-match free members |
| `who is near me`, `who is here` | Lists members checked-in today |
| `find me AI founders` | Top 3 matches via LLM |
| `intro me to someone` | One cross-section match, drafts intro, asks `yes` |
| `I am alone` | Nearest open event cluster + one-tap join |
| `join dinner` | Disambiguates which dinner, RSVPs you |
| `yes` / `no` / `1` / `2` | Confirmation / disambiguation to the bot's prior question |
| `stop` | Opts you out of WhatsApp messages immediately |
| `help` | Returns the command list |

The bot **always asks for `yes` before any action that touches other members** (creating events, sending intros, RSVPing).

---

## 4. Screen inventory

Legend: **M** = ship for VivaTech launch. **S** = ship if Week 2 holds. **L** = later.

### Public / auth

| # | Screen | Purpose | Key elements | States to design |
| --- | --- | --- | --- | --- |
| 01 | **Landing — public** | Convey curated, warm, human; gate access | Hero (image, tagline, sub), single CTA *I have an invite code*, secondary *Request consideration*, 3 value-prop blocks, manifesto excerpt, FAQ, host card, footer | Default, loading skeleton |
| 02 | **Landing — invited** | Welcome the invited person, pre-fill code | Same as 01 with hero changed to "You've been invited" + code pre-filled + primary CTA = Continue | Default |
| 03 | **Invite Code Entry (modal)** | Accept pasted code if not arrived via deep link | Single input (auto-uppercase, auto-format dashes), Continue, "Don't have one?" link | Empty, validating, valid, invalid, expired |
| 04 | **Auth** | Sign in with LinkedIn | One big "Sign in with LinkedIn" button. Tagline: *"This circle is built around LinkedIn-based founders. Sign in with the same account you use professionally."* | Default, signing in, error |
| 05 | **Visitor Request Form** | Non-invited visitors ask in | Name, LinkedIn URL, 1 sentence "why fit", Submit → confirmation | Form, submitting, success, error |

### Applicant

| # | Screen | Purpose | Key elements | States |
| --- | --- | --- | --- | --- |
| 06 | **Application Form** | Triage-level info post-auth | 5–7 fields (see §5), single stepper, progress dots | Form, validating, submitting, success |
| 07 | **AI Profile Interview** | Warm 6–8 turn chat that fills the rest of the profile | Full-height chat surface, AI avatar (subtle), suggestion chips, thin progress bar ("Q3 of ~7"), skip affordance, "Save & finish later" | Empty (greeting), user typing, AI typing, error, finished, saving |
| 08 | **Application Pending** | Hold state after interview | Warm illustration, "Franek personally reviews — usually <24h", show what was submitted (collapsed), edit | Pending, rejected (warm copy), needs-more-info (banner) |
| 09 | **Welcome / Onboarding** | Convert approval into WhatsApp join + first action | 3 cards: (1) WhatsApp join button (huge, green) (2) code of conduct accept checkbox (3) "three things you can do now" | Post-approval, already-onboarded |

### Member

| # | Screen | Purpose | Key elements | States |
| --- | --- | --- | --- | --- |
| 10 | **Member Home** | Daily dashboard | Next event card + RSVP status + attendee avatars, "Suggested for you" (1–2 buddy cards), "New in the circle" (recent members), pinned host note, **Free now toggle** in header, **Find a crew** card, "Your profile completeness" gauge (sidebar on desktop) | Empty (pre-launch), populated, error |
| 11 | **Directory** | Discover other members | Search bar, filter chips (sector, stage, looking-for, language, "attending event X"), grid of member cards (photo, name, headline, 1-line "building") | Empty, loading, no-results, populated |
| 12 | **Member Profile (view)** | See another member | Header (photo, name, headline, flag, languages), "Building" section, "At VivaTech for", "Going to" (RSVP'd events), CTAs *Request intro via Franek*, *Open LinkedIn* | Default, intro-requested |
| 13 | **My Profile (edit)** | Edit own profile | Same fields as application + interview output, photo (default from LinkedIn), preview toggle ("How others see me"), Re-do the interview *(S)* | Editing, saving, saved, error |
| 14 | **Events List** | Upcoming micro-events | Vertical list of event cards (image/emoji, title, date+time, neighborhood, capacity bar, attendee avatars, RSVP button) | Empty, loading, populated, past-events tab *(S)* |
| 15 | **Event Detail** | RSVP + see buddies + see who's going | Hero (image, title, date/time, place — address only post-RSVP), description, capacity, RSVP button (not-RSVP'd / RSVP'd / waitlisted / full), attendee list, **Suggested buddies for this event** section (post-RSVP), host note, .ics download | Pre-RSVP, RSVP'd, waitlist, full, cancelled |
| 16 | **Free Now sheet** | Set availability + see free others | Time picker (15min / 1h / today), list of currently-free members ranked by match score, "want coffee?" CTA per row | Sheet open, status set, no others free |
| 17 | **Find a Crew** *(card on Home, optional standalone)* | Solo attendee → cluster join | Card on Home: "4 founders at Café Marly breakfast tomorrow — join them?" One-tap RSVP | Card visible, joined, no-clusters |
| 18 | **Buddy Suggestions** | Per-event buddy match (embedded in 15) | 2–3 cards with photo, name, headline, AI 1-sentence "Why you'd click", **Introduce us** + **Skip** | Loading, ready, intro-requested, none-found |
| 19 | **Code of Conduct / Manifesto** | Set the tone + rules | Long-form text page with sections (Who this is for / Who it's not / How we behave / Data / How to leave) | Default |

### Admin

| # | Screen | Purpose | Key elements | States |
| --- | --- | --- | --- | --- |
| 20 | **Admin Dashboard** | Ops at a glance | 4 stat cards (pending, members, next event + RSVPs, WhatsApp group count), CTAs: Review applications, Create event, Send blast | Empty, populated |
| 21 | **Applications Inbox** | Triage applicants | List of rich cards (photo, headline, "what they're building", AI curation score 0–100 + 1-sentence rationale, interview transcript collapsed). Bulk actions, per-card Approve / Reject / Ask for more info / Open LinkedIn. Filter: pending / approved / rejected / needs-info | Empty, loading, populated |
| 22 | **Events Admin (list + editor)** | CRUD events | List = member events + edit/cancel + draft state. Editor: form (§6) + toggles "Announce on WhatsApp on save?" + "Reminder 24h before?" + capacity + preview | Create, edit, saving, cancelled, announced |
| 23 | **Event RSVPs** | See and manage attendees | Table (name, RSVP time, dietary, +1 if allowed). Export CSV *(S)*. Send-message-to-attendees button | Default, exporting |
| 24 | **Blast Composer** *(S)* | Compose + send WhatsApp blasts | Audience selector (whole group / RSVPs to X / new members / custom), textarea with merge tags (`{{firstName}}`), **Draft with AI** + template picker, preview as it'll look in WhatsApp, send with double-confirm modal. Post-send: delivery status list, retry | Empty, drafting, AI-drafting, preview, sending, sent, partial-failure |
| 25 | **Member Admin** *(S)* | Manage existing members | Searchable list, per-member actions (view profile, change role, soft-remove, regenerate WhatsApp link) | Default |
| 26 | **Invite Codes Admin** *(S)* | Create / track codes | List with status (unused / consumed / expired / revoked), who consumed when. Create-code form (note, expiry, single/multi-use, optional pre-fill name) | Default, generating |

### Utility

| # | Screen | Purpose | Key elements |
| --- | --- | --- | --- |
| 27 | **404 / Access Denied** | Warm gate | Copy: *"This door is invite-only"* + LinkedIn DM link to Franek |
| 28 | **Privacy + Terms** | Legal | Plain language, names Whapi.cloud + what's stored where |
| 29 | **Loading / Skeleton patterns** | Reusable | Card skeleton, list skeleton, profile skeleton |

**Total: 19 MUST + 5 SHOULD + 3 utility = 27 screens.** Reuse a single Card component pattern (photo + headline + meta + CTA) across Directory / Events / Applications / Members to keep design time tight.

---

## 5. Profile fields (member data model)

What gets captured. `[A]` = application form, `[I]` = AI interview, `[L]` = auto-imported from LinkedIn, `[*]` = shown in the directory by default.

### Identity
- `fullName` [A, L, *]
- `photoUrl` [L, *] — editable
- `linkedinUrl` [A, *]
- `email` [auth, private]
- `whatsappPhoneE164` [A, **private**] — required to receive bot messages
- `cityCountry` [A, *] — e.g. "Berlin, DE"
- `flagEmoji` [auto, *]

### Work
- `headline` [A or L, *] — ≤80 chars, e.g. "Building climate AI at Tellus"
- `currentRole` [A] — enum: founder / builder-eng / builder-design / investor / operator / researcher / journalist / student / other
- `companyName` [A, *]
- `companyStage` [A] — idea / pre-seed / seed / series A+ / bootstrapped / not-a-company
- `sector` [A, *] — multi: AI / climate / fintech / health / dev tools / consumer / hardware / deep tech / web3 / other
- `building` [I, *] — ≤280 chars, AI-summarized

### VivaTech context
- `atVivaTechFor` [I, *] — multi: meet investors / customers / hire / find cofounder / learn / inspiration / it's-an-excuse-to-be-in-Paris
- `sessionsAttending` [I] — free text
- `daysAtVivaTech` [A] — multi: Wed / Thu / Fri / Sat
- `lookingToMeet` [I, *] — ≤280 chars (the actual matching signal)
- `notLookingFor` [I, **private**] — used by matching, never displayed

### Social signal
- `socialEnergy` [I, *] — parties / small-dinners / 1-on-1 / mix
- `languagesSpoken` [A, *] — multi
- `funFact` [I, *] — ≤140 chars

### Operational
- `dietary` [A, **private to admin**] — multi + free text
- `consentDirectoryVisible` [A, default true]
- `consentAiMatching` [A, default true]
- `consentWhatsappMessages` [A, default true]
- `consentEventsVisibleOnProfile` [A, default true]

### System (not user-edited)
- `role`, `status` (invited → applicant → approved → rejected → removed)
- `curationScore` [admin-only, 0–100]
- `curationRationale` [admin-only, 1 sentence]
- `freeUntil` (live ops — for "Free now")
- `checkedInToday` (live ops — for "Who is here")
- `createdAt`, `approvedAt`, `lastActiveAt`

**User-typed fields total: ~10.** AI interview fills the rest from the chat.

---

## 6. Event fields (lightweight micro-events)

### Display
- `title` — ≤60 chars, e.g. "Founders' Breakfast — Café de Flore"
- `kind` — enum with emoji: breakfast / coffee / lunch / drinks / dinner / rooftop / walk / side-event / other
- `coverImageUrl` (optional, default per kind)
- `description` — markdown, host's voice
- `hostName` — default "Franek"
- `hostNote` — optional, host voice

### When / where
- `startAt`, `endAt` (Paris time)
- `addressFull` — **shown only post-RSVP**
- `addressNeighborhood` — shown pre-RSVP (e.g. "6e arrondissement")
- `mapUrl` (optional)

### Capacity / RSVP
- `capacity` (e.g. 12)
- `allowWaitlist` (default true)
- `allowPlusOne` (default false)
- `rsvpDeadline` (optional)
- `visibility` — all-members (default) / invited-list *(S)*
- `invitedMemberIds[]` (when visibility = invited-list)

### Notifications
- `announceOnCreate` (default true → triggers WhatsApp blast)
- `reminderHoursBefore` (default 24)
- `postEventThankYou` (default true) *(S)*

### State
- `status` — draft / scheduled / live / past / cancelled

---

## 7. Content to prepare (block on this for design)

Without these, screens are placeholders. Most important first:

1. **Manifesto / code of conduct** — 400–600 words. The most load-bearing copy on the site. *Who this is for / who it's not / how we behave / data / how to leave.*
2. **Hero headline + sub** (2 A/B variants)
3. **3 value-prop blocks** for landing — title + 1 sentence each
4. **Host card** — 1 paragraph about Franek + photo + LinkedIn
5. **FAQ** — 6–8 Q&As (How do I get in / Why invite-only / Cost / Post-event / Data / +1s / For investors / How to leave)
6. **Privacy policy** — short, plain language, names Whapi.cloud
7. **AI interview system prompt + 8–10 question seeds in Franek's voice**
8. **WhatsApp message templates** — welcome / event-announce / T-24h reminder / day-of / thank-you / intro-opener (each ≤280 chars, warm)
9. **Rejection copy** — kind, doesn't burn bridges (~3 sentences)
10. **2 placeholder events** so the directory isn't empty on launch
11. **LinkedIn DM template** for outreach (not on the site, but drives the funnel)

### Visuals

- **Hero image** — Paris-feeling, NOT corporate stock. Real photo from Franek (rooftop, café) preferred over generic.
- **Logo / wordmark** — simple. "Founders & Builders @ VivaTech" or the chosen final name.
- **Palette** — warm neutral base (cream/off-white), one accent (deep green or terracotta — NOT corporate blue). Currently in code: `bg #FAF7F2`, `ink #1F1D1A`, `accent #C9522B`.
- **Type** — one serif headline + one sans body. Currently in static landing: Fraunces (serif) + Inter (sans).
- **Event-kind emojis / icons** for breakfast / coffee / drinks / etc.
- **Empty-state illustrations** for: no events yet, no buddies yet, profile not complete (3 small)
- **Open Graph image** — for LinkedIn DM previews

---

## 8. Non-functional requirements

- **Responsive:** mobile ≤599px (single column, sticky bottom CTAs), tablet 600–1023px (2-col grids), desktop ≥1024px (3-col grids, max width 1280px, sidebar on Home)
- **Performance:** landing page (`/`) is static HTML → sub-second first paint + proper Open Graph for LinkedIn previews. Flutter app loads only under `/app/*`. Auth screens target TTI <3s on mid-range mobile / 4G.
- **i18n:** English only for v1. One French line in the landing hero is fine (e.g. *"Une petite circle of founders à Paris"*). Architect for i18n but ship en-US.
- **Accessibility:** semantic labels on interactive widgets, contrast ≥4.5:1, keyboard nav on admin flows, visible labels (not just placeholders). Full WCAG AA = post-event.
- **Privacy:** privacy policy explicitly names Whapi.cloud as the WhatsApp relay through Franek's number. Members can opt out of WhatsApp while keeping site access. Right-to-delete within 30 days. Member phones never appear in any directory.
- **Browser support:** latest 2 versions of Chrome / Safari / Edge / Firefox + mobile Safari + Chrome Android.

---

## 9. Out of scope for v1 (LATER)

Design hooks may exist but don't build:

- In-app chat / DMs (WhatsApp owns this — never)
- Payments / paid tiers
- Video calls
- Opportunity board ("what I'm looking for" wall)
- Multi-event / multi-cohort tenancy
- Native mobile app
- Calendar OAuth sync (provide .ics only)
- Public / SEO-indexable profiles (never — invite-only forever)
- Photo gallery from events
- Post-event surveys (use a Google Form via WhatsApp)
- Monthly virtual coffee pairings (post-event) — design hook only
- LinkedIn connections import (LinkedIn API doesn't allow it — would need user CSV upload, deferred)

---

## 10. Open product questions (need Franek's call before design lock-in)

1. **Final name + domain.** "Founders & Builders @ VivaTech" vs alternatives. Affects logo, OG image, all copy.
2. **Whapi.cloud account + dedicated SIM** — Day 1 procurement.
3. **WhatsApp group structure:** one main group + ephemeral 3-person buddy intro groups? Confirm.
4. **Co-admin?** Anyone else with admin custom claim? Affects whether Member Admin role-change UI is MUST.
5. **Typical event capacity:** 6–15 (intimate) vs 50+ (rooftop drinks)? Affects RSVP UI density and waitlist logic.
6. **AI curation score:** shown to admin or hidden? Recommendation: shown but advisory.
7. **Post-event lifecycle:** keep cohort active through end of June 2026 then archive? Affects manifesto copy.
8. **Brand assets:** designer or DIY for hero image / palette / logo?
