/**
 * Bot localization — English + French (VivaTech is in Paris).
 *
 * Two surfaces get localized:
 *  1. Deterministic harness strings (event confirmations, intro flow,
 *     cancellations, menu) — via the `msg(lang)` bundle below.
 *  2. Claude-generated replies (matching, conversation) — the brain injects a
 *     "reply in <language>" directive into the context block; Claude does the
 *     rest natively, so we don't translate those by hand.
 *
 * The user's choice lives on users/{uid}.preferredLanguage ("en" | "fr").
 */

export type Lang = "en" | "fr";

export function normalizeLang(raw: unknown): Lang {
  const s = String(raw ?? "").trim().toLowerCase();
  if (
    s.startsWith("fr") ||
    s.includes("français") ||
    s.includes("francais") ||
    s === "2"
  ) {
    return "fr";
  }
  return "en";
}

export function languageName(lang: Lang): string {
  return lang === "fr" ? "Français" : "English";
}

// `language` / `langue` / `lang` [optional: fr|en|français|english|1|2].
// Returns matched=false when it's not a language command. When matched with no
// (or unknown) argument, lang is null → caller shows the options prompt.
const LANG_CMD_RE = /^\s*\/?(?:language|langue|lang|idioma)\b\s*(.*)$/i;

export function parseLanguageCommand(
  text: string
): { matched: boolean; lang: Lang | null } {
  const m = text.trim().match(LANG_CMD_RE);
  if (!m) return { matched: false, lang: null };
  const rest = m[1].trim();
  if (!rest) return { matched: true, lang: null };
  return { matched: true, lang: parseLangReply(rest) };
}

// A bare language reply (used when we asked the user to pick).
export function parseLangReply(text: string): Lang | null {
  const r = text.trim().toLowerCase().replace(/[^a-zà-ÿ0-9]/g, "");
  if (/^(fr|french|francais|français|2)$/.test(r)) return "fr";
  if (/^(en|eng|english|anglais|1)$/.test(r)) return "en";
  return null;
}

// Multilingual yes / no — confirmations must work for French users too.
export function isYesWord(text: string): boolean {
  return /^(yes|y|yep|yeah|ok|okay|confirm|do it|go|sure|oui|ouais|ouaip|d'accord|daccord|vas-y|ouip)$/i.test(
    text.trim()
  );
}

export function isNoWord(text: string): boolean {
  return /^(no|n|nope|cancel|stop that|abort|nah|non|annule|annuler|laisse tomber|nan|passe)$/i.test(
    text.trim()
  );
}

interface EventAnnounceArgs {
  emoji: string;
  title: string;
  when: string;
  place: string;
  hostName: string;
  description?: string;
}

export interface Bundle {
  cancelled: string;
  createEventPrompt: string;
  eventCreated: (title: string, pinged: number, unreachable: number) => string;
  eventAnnounce: (a: EventAnnounceArgs) => string;
  introSent: (name: string) => string;
  introRequest: (
    from: string,
    bio: string,
    opener: string,
    linkedinUrl?: string
  ) => string;
  introAccepted: (name: string, contact: string) => string;
  introConnected: (name: string, contact: string) => string;
  introDeclined: string;
  introPassed: string;
  introRequestExpired: string;
  contactReachesOut: (name: string) => string;
  langPrompt: string;
  langSet: (name: string) => string;
  menu: string;
}

const EN: Bundle = {
  cancelled: "Cancelled.",
  createEventPrompt:
    'What\'s the event? One message — title, when, where. ' +
    'Example: "Drinks tonight 8pm at Café Marly, max 12." ' +
    "Reply cancel to back out.",
  eventCreated: (title, pinged, unreachable) =>
    `✓ "${title}" created. Pinging ${pinged} members` +
    (unreachable > 0 ? ` (${unreachable} unreachable)` : "") +
    ".",
  eventAnnounce: (a) =>
    [
      `${a.emoji} ${a.title}`,
      `${a.when} · ${a.place}`,
      `Hosted by ${a.hostName}.`,
      ...(a.description ? [a.description] : []),
      `Reply "join ${a.title}" to RSVP.`,
    ].join("\n"),
  introSent: (name) =>
    `Sent your request to ${name}. I'll let you know if they're in.`,
  introRequest: (from, bio, opener, linkedinUrl) =>
    `${from}${bio ? ` (${bio})` : ""} wants to connect 👋\n\n` +
    `"${opener}"\n` +
    (linkedinUrl ? `\nCheck them out: ${linkedinUrl}\n` : "") +
    `\nReply yes to swap contacts, or no to pass.`,
  introAccepted: (name, contact) =>
    `${name} accepted your intro 🎉\n\nReach them — ${contact}`,
  introConnected: (name, contact) =>
    `Connected with ${name} 🎉\n\nReach them — ${contact}`,
  introDeclined:
    "Your intro request didn't connect this time. " +
    "Plenty more people to meet — try find me a buddy.",
  introPassed: "No problem — I won't share your contact. Passed.",
  introRequestExpired:
    "That request expired — the other person isn't reachable.",
  contactReachesOut: (name) => `${name} (they'll reach out to you)`,
  langPrompt:
    "Which language? Reply english or français.\n" +
    "Quelle langue ? Répondez english ou français.",
  langSet: (name) => `Done — I'll speak ${name} from now on.`,
  menu:
    "Here's what I can do:\n" +
    "• find me a buddy — I pick one person worth meeting and can intro you\n" +
    '• find me <topic> — specific people (e.g. "find me a climate VC")\n' +
    "• create event — propose a meetup; I'll ping everyone who can come\n" +
    "• who is here — quick look at who's in the circle\n" +
    "• free for 30 — flag you're free now; I'll find someone free to meet\n" +
    "• language — switch English / Français\n" +
    "• help — see this menu again\n" +
    "• stop — opt out of messages",
};

const FR: Bundle = {
  cancelled: "Annulé.",
  createEventPrompt:
    "Quel événement ? En un message — titre, quand, où. " +
    "Exemple : « Verres ce soir 20h au Café Marly, max 12. » " +
    "Répondez annuler pour abandonner.",
  eventCreated: (title, pinged, unreachable) =>
    `✓ « ${title} » créé. J'envoie l'info à ${pinged} membres` +
    (unreachable > 0 ? ` (${unreachable} injoignables)` : "") +
    ".",
  eventAnnounce: (a) =>
    [
      `${a.emoji} ${a.title}`,
      `${a.when} · ${a.place}`,
      `Organisé par ${a.hostName}.`,
      ...(a.description ? [a.description] : []),
      `Répondez « join ${a.title} » pour vous inscrire.`,
    ].join("\n"),
  introSent: (name) =>
    `Demande envoyée à ${name}. Je te préviens s'il/elle est partant·e.`,
  introRequest: (from, bio, opener, linkedinUrl) =>
    `${from}${bio ? ` (${bio})` : ""} veut se connecter 👋\n\n` +
    `« ${opener} »\n` +
    (linkedinUrl ? `\nSon profil : ${linkedinUrl}\n` : "") +
    `\nRéponds oui pour échanger vos contacts, ou non pour passer.`,
  introAccepted: (name, contact) =>
    `${name} a accepté ton intro 🎉\n\nContacte-le/la — ${contact}`,
  introConnected: (name, contact) =>
    `Connecté·e avec ${name} 🎉\n\nContacte-le/la — ${contact}`,
  introDeclined:
    "Ta demande d'intro n'a pas abouti cette fois. " +
    "Plein d'autres personnes à rencontrer — essaie trouve-moi un binôme.",
  introPassed: "Pas de souci — je ne partage pas ton contact. Passé.",
  introRequestExpired:
    "Cette demande a expiré — la personne n'est plus joignable.",
  contactReachesOut: (name) => `${name} (il/elle te recontactera)`,
  langPrompt:
    "Quelle langue ? Répondez english ou français.\n" +
    "Which language? Reply english or français.",
  langSet: (name) => `C'est noté — je te parle en ${name} désormais.`,
  menu:
    "Voici ce que je peux faire :\n" +
    "• trouve-moi un binôme — je choisis une personne à rencontrer et je peux vous présenter\n" +
    "• trouve-moi <sujet> — des personnes précises (ex. « trouve-moi un VC climat »)\n" +
    "• créer événement — propose un rendez-vous ; je préviens ceux que ça intéresse\n" +
    "• qui est là — un aperçu du cercle\n" +
    "• libre 30 — signale que tu es dispo ; je trouve quelqu'un de libre\n" +
    "• langue — passer English / Français\n" +
    "• help — revoir ce menu\n" +
    "• stop — ne plus recevoir de messages",
};

export function msg(lang: Lang): Bundle {
  return lang === "fr" ? FR : EN;
}

// The directive injected into Claude's context so its (non-deterministic)
// replies come back in the user's language.
export function claudeLanguageDirective(lang: Lang): string {
  return lang === "fr"
    ? "IMPORTANT: Reply to this user in natural, native French (français). Every message you send them must be in French."
    : "Reply to this user in English.";
}
