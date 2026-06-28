/**
 * Self-serve demo onboarding, shared by the Telegram and WhatsApp webhooks.
 *
 * The marketing site's "Try the live demo" page lets a prospect pick a channel:
 *   - Telegram → deep-links `t.me/<bot>?start=demo` (one tap).
 *   - WhatsApp → opens the Twilio sandbox `join <code>` message; the FIRST
 *     message from any unbound number is then treated as a demo opt-in.
 *
 * Either way the webhook mints an ephemeral `isDemo` account, marks onboarding
 * complete, and greets with the welcome below — which frames the sandbox
 * honestly (sample attendees) and ends on the book-a-call CTA so the funnel
 * closes on Calendly. Demo accounts are filtered out of every real member's
 * directory in the bot brain (`isDemo`), so a prospect's throwaway account never
 * surfaces as a real match.
 */

export const DEMO_START_PAYLOAD = "demo";
export const DEMO_CALENDLY_URL = "https://calendly.com/franek-1/founding-ot";

export function demoWelcome(lang: "en" | "fr", greetingName: string): string {
  return lang === "fr"
    ? `👋 Bienvenue dans la démo, ${greetingName} ! Tu parles au vrai concierge — les personnes ici sont des participants fictifs, pour tout tester pour de vrai.\n\n` +
        "Essaie :\n" +
        "• trouve-moi un VC climat — explore les gens tout de suite\n" +
        "• trouve-moi un binôme — match + mise en relation\n" +
        "• créer événement — lance un rendez-vous (je préviens tout le monde)\n\n" +
        `Quand tu as le ressenti, réserve un appel avec Franek → ${DEMO_CALENDLY_URL}`
    : `👋 Welcome to the demo, ${greetingName}! You're chatting with the real concierge — the people here are sample attendees, so you can try everything for real.\n\n` +
        "Give it a go:\n" +
        "• find me a climate VC — browse people instantly\n" +
        "• find me a buddy — get matched and introduced\n" +
        "• create event — spin up a meetup (I'll invite everyone)\n\n" +
        `When you've got the feel, book a call with Franek → ${DEMO_CALENDLY_URL}`;
}
