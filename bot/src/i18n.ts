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
// Uses `\b` (not `$`) so the user echoing the button label still counts:
// "yes create it", "yes please", "ok do it" all match. A word-boundary anchor
// is required so "yesterday" / "noting" / "going" don't false-match.
export function isYesWord(text: string): boolean {
  return /^(yes|y|yep|yeah|ok|okay|confirm|do it|go|sure|oui|ouais|ouaip|d'accord|daccord|vas-y|ouip)\b/i.test(
    text.trim()
  );
}

export function isNoWord(text: string): boolean {
  return /^(no|n|nope|cancel|stop that|abort|nah|non|annule|annuler|laisse tomber|nan|passe)\b/i.test(
    text.trim()
  );
}

// Lenient confirmation detection for the yes/no fast-paths. People rarely reply
// with the bare token — they echo the CTA ("yes create it", "ok do it",
// "yeah go ahead", "oui crée-le"). The strict word matchers above missed these,
// so the pending action was silently dropped and the message fell through to
// Claude, which re-proposed the action and re-showed the Yes/No buttons.
// Matches a LEADING yes/no word (optionally followed by anything); a leading
// no-word always wins so "ok no thanks" reads as a decline, not a confirm.
// `create(?!\s+(?:a\b|an\b|new\b|another\b|event|[ée]v[ée]nement))` accepts the
// English echo of the "✅ Yes, create it" button ("create it", "create", "create
// now") while still letting "create event" / "create a new event" fall through
// to the event-creation wizard rather than confirming a stale pending action.
const YES_LEAD =
  /^(?:yes|yep|yeah|yup|ok|okay|sure|confirm(?:ed)?|go|go ahead|do it|sounds good|please do|let'?s do it|create(?!\s+(?:a\b|an\b|new\b|another\b|event|[ée]v[ée]nement))|oui|ouais|ouaip|ouip|d'?accord|daccord|vas-y|c'?est bon|parfait|crée|cree)\b/i;
const NO_LEAD =
  /^(?:no|nope|nah|cancel|abort|don'?t|never ?mind|nvm|non|annule[rz]?|laisse tomber|nan|passe|pas maintenant)\b/i;

export function isAffirmative(text: string): boolean {
  const t = text.trim();
  if (isNoWord(t) || NO_LEAD.test(t)) return false;
  return isYesWord(t) || YES_LEAD.test(t);
}

export function isNegative(text: string): boolean {
  const t = text.trim();
  return isNoWord(t) || NO_LEAD.test(t);
}

// The incoming-intro prompt shows "🤝 Connect" / "Pass" buttons. People often
// type the visible label instead of tapping, so accepting/declining a
// connection must recognise those words too — otherwise "Connect" falls through
// to Claude and the request never resolves.
export function isConnectWord(text: string): boolean {
  const t = text.trim();
  return (
    isAffirmative(t) ||
    /^(?:🤝\s*)?(?:connect|connecter|se\s+connecter|connecte)\b/i.test(t)
  );
}

export function isPassWord(text: string): boolean {
  const t = text.trim();
  return isNegative(t) || /^(?:pass|passer|d[ée]clin(?:e|er)|decline)\b/i.test(t);
}

interface EventAnnounceArgs {
  emoji: string;
  title: string;
  when: string;
  place: string;
  hostName: string;
  description?: string;
}

// The "your event changed" notice sent to each attendee after an owner edit.
interface EventUpdateArgs {
  title: string;
  when: string;
  place: string;
  hostName: string;
}

// Labels for Telegram inline-keyboard CTA buttons. Localized so a French user
// taps "Oui" not "Yes". The button's callback_data is always the canonical
// English token ("yes"/"no"/"join <id>") so the brain's text matching is
// language-independent — only the visible label is translated.
export interface BtnLabels {
  yesPing: string; // confirm an intro proposal
  yesCreate: string; // confirm an event-creation proposal
  yesCancel: string; // confirm cancelling an event you host
  yesEdit: string; // confirm an edit to an event you host
  no: string;
  connect: string; // accept an incoming intro request
  pass: string; // decline an incoming intro request
  join: string; // RSVP to a broadcast event
  edit: string; // "Edit" — prefixes an event title in the `my events` list
  cancelEvt: string; // "Cancel" — prefixes an event title in the `my events` list
}

export interface Bundle {
  cancelled: string;
  createEventPrompt: string;
  eventCreated: (title: string, pinged: number, unreachable: number) => string;
  // withCta=false drops the trailing "Reply …" line — used on Telegram where a
  // tap-button replaces it (see brain.ts / actions.ts channel routing).
  eventAnnounce: (a: EventAnnounceArgs, withCta?: boolean) => string;
  introSent: (name: string) => string;
  introRequest: (
    from: string,
    bio: string,
    opener: string,
    linkedinUrl?: string,
    withCta?: boolean
  ) => string;
  introAccepted: (name: string, contact: string) => string;
  introConnected: (name: string, contact: string) => string;
  introDeclined: string;
  introPassed: string;
  introRequestExpired: string;
  introBrowseNudge: string;
  contactReachesOut: (name: string) => string;
  langPrompt: string;
  // Short prompt shown alongside the 🇬🇧/🇫🇷 buttons on Telegram (no "reply" text).
  langPromptShort: string;
  langSet: (name: string) => string;
  // RSVP via `join <event>` (or the Join button). On RSVP we reveal the exact
  // address (public listings only show the neighborhood) + the start time, and
  // — on Telegram, when the event has a forum topic — a link to coordinate.
  rsvpJoined: (
    title: string,
    place: string,
    when: string,
    groupLink?: string
  ) => string;
  rsvpNotFound: string;
  rsvpAmbiguous: string;
  // Someone tried to RSVP to an event they host — they're already in as the host.
  rsvpOwnEvent: (title: string) => string;
  // RSVP status query — "have I signed in?", "am I in?", "which events am I
  // going to?". Answered concisely instead of dumping the full what's-on list.
  rsvpStatusList: (lines: string[]) => string;
  rsvpStatusNone: string;
  // RSVP status query naming ONE specific event the user is NOT signed in for.
  rsvpStatusNotFor: (title: string) => string;
  // Owner event management — `my events`, edit/cancel flows, and the notices
  // sent to attendees when the host changes or calls off an event.
  myEventsHeader: string;
  myEventsEmpty: string;
  myEventsHint: string;
  // `what's on` listing — header + warm empty line + a text-channel RSVP hint.
  // On Telegram the empty line/hint are replaced by a per-event Join tap-button.
  whatsOnHeader: string;
  whatsOnEmpty: string;
  whatsOnHint: string;
  editPrompt: (title: string) => string;
  editNoChanges: string;
  notYourEvent: string;
  ownedEventAmbiguous: string;
  eventGone: string;
  cancelConfirm: (title: string, attendees: number) => string;
  eventCancelled: (title: string, notified: number) => string;
  eventAlreadyCancelled: (title: string) => string;
  // Host tried to cancel an event that's already underway — refused.
  cantCancelOngoing: (title: string) => string;
  eventCancelledNotice: (title: string, hostName: string) => string;
  eventUpdated: (title: string, notified: number) => string;
  eventUpdatedNotice: (a: EventUpdateArgs) => string;
  // Reminder sent to each RSVP'd attendee ~24h before the event starts.
  eventReminder: (title: string, when: string, place: string) => string;
  // Online Tribes group chat: the host links their OT username once, then each
  // event auto-gets a tribe they own; the invite link is shared with attendees.
  tribeReady: (link: string) => string;
  otUsernamePrompt: string;
  otUsernameConfirm: (handle: string, name: string) => string;
  otUsernameNotFound: string;
  otUsernameSkipped: string;
  otUsernameError: string;
  btn: BtnLabels;
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
  eventAnnounce: (a, withCta = true) =>
    [
      `${a.emoji} ${a.title}`,
      `${a.when} · ${a.place}`,
      `Hosted by ${a.hostName}.`,
      ...(a.description ? [a.description] : []),
      ...(withCta ? [`Reply "join ${a.title}" to RSVP.`] : []),
    ].join("\n"),
  introSent: (name) =>
    `Sent your request to ${name}. I'll let you know if they're in.`,
  introRequest: (from, bio, opener, linkedinUrl, withCta = true) =>
    `${from}${bio ? ` (${bio})` : ""} wants to connect 👋\n\n` +
    `"${opener}"\n` +
    (linkedinUrl ? `\nCheck them out: ${linkedinUrl}\n` : "") +
    (withCta ? `\nReply yes to swap contacts, or no to pass.` : ""),
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
  introBrowseNudge: "Want an intro? Reply `intro me to` and their name.",
  contactReachesOut: (name) => `${name} (they'll reach out to you)`,
  langPrompt:
    "Which language? Reply english or français.\n" +
    "Quelle langue ? Répondez english ou français.",
  langPromptShort: "Which language? · Quelle langue ?",
  langSet: (name) => `Done — I'll speak ${name} from now on.`,
  rsvpJoined: (title, place, when, groupLink) =>
    [
      `✅ You're signed in for "${title}"`,
      place || when ? `📍 ${[place, when].filter(Boolean).join(" · ")}` : null,
      groupLink ? `Coordinate with the group: ${groupLink}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  rsvpNotFound:
    'Couldn\'t find that event. Reply "what\'s on" to see what\'s scheduled.',
  rsvpAmbiguous:
    'More than one event matches — reply "what\'s on" and use the exact title.',
  rsvpOwnEvent: (title) =>
    `You're hosting "${title}" — you're already in. Reply \`my events\` to edit or cancel it.`,
  rsvpStatusList: (lines) =>
    `✅ Yes — you're signed in for:\n${lines.map((l) => `• ${l}`).join("\n")}`,
  rsvpStatusNone:
    'Not yet — you haven\'t signed in for any event. Reply "what\'s on" to pick one.',
  rsvpStatusNotFor: (title) =>
    `Not yet — you're not signed in for "${title}". Reply "what's on" to find it.`,
  myEventsHeader: "Events you host:",
  myEventsEmpty:
    "You're not hosting any events yet. Reply `create event` to start one.",
  myEventsHint: "Reply `edit event <title>` or `cancel event <title>` to manage one.",
  whatsOnHeader: "Here's what's coming up:",
  whatsOnEmpty:
    "Nothing on the calendar yet — want to be the first? Reply `create event`.",
  whatsOnHint: 'Reply "join" + the event name to RSVP.',
  editPrompt: (title) =>
    `Editing "${title}". What should change? (e.g. time to 9am, place to Café X, cap 15, or rename). Reply cancel to stop.`,
  editNoChanges: "Nothing changed — that's still how the event stands.",
  notYourEvent: "That's not an event you host, so I can't change it.",
  ownedEventAmbiguous:
    "You host more than one event — reply `my events` to pick the one you mean.",
  eventGone: "That event isn't available anymore.",
  cancelConfirm: (title, attendees) =>
    `Cancel "${title}"? ` +
    (attendees > 0
      ? `I'll let the ${attendees} ${attendees === 1 ? "person" : "people"} who RSVP'd know. `
      : "") +
    "Reply yes to confirm.",
  eventCancelled: (title, notified) =>
    `✓ "${title}" cancelled` +
    (notified > 0 ? ` — notified ${notified} ${notified === 1 ? "person" : "people"}` : "") +
    ".",
  eventAlreadyCancelled: (title) => `"${title}" was already cancelled.`,
  cantCancelOngoing: (title) =>
    `"${title}" is already underway, so I can't cancel it now. You can still edit the details if something changed.`,
  eventCancelledNotice: (title, hostName) =>
    `Heads up — "${title}"${hostName ? ` (hosted by ${hostName})` : ""} has been cancelled. ✕`,
  eventUpdated: (title, notified) =>
    `✓ "${title}" updated` +
    (notified > 0 ? ` — notified ${notified} ${notified === 1 ? "person" : "people"}` : "") +
    ".",
  eventUpdatedNotice: (a) =>
    [
      `Update on "${a.title}" 🔄`,
      [a.when, a.place].filter(Boolean).join(" · "),
      a.hostName ? `Hosted by ${a.hostName}.` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  eventReminder: (title, when, place) =>
    [
      `⏰ Reminder: "${title}" is coming up`,
      [when, place].filter(Boolean).join(" · ") || null,
      "See you there!",
    ]
      .filter(Boolean)
      .join("\n"),
  tribeReady: (link) => `🎪 Group chat ready — share it with attendees: ${link}`,
  otUsernamePrompt:
    "One more thing — what's your Online Tribes username? I'll spin up a group chat for this event that you'll own. " +
    "No account yet? Create one at https://online-tribes.com, then come back and reply your username. (Or reply skip.)",
  otUsernameConfirm: (handle, name) =>
    `Found Online Tribes user @${handle}${name && name !== handle ? ` (${name})` : ""}. ` +
    `Set up the group owned by this account? Reply yes, send a different username, or skip.`,
  otUsernameNotFound:
    "Couldn't find that Online Tribes username. Double-check it (or sign up at online-tribes.com) and reply it again — or reply skip to add the group later.",
  otUsernameSkipped:
    "No worries — your event's live. You can add an Online Tribes group later.",
  otUsernameError:
    "Couldn't set up the group right now — your event's live; we'll sort the group out later.",
  btn: {
    yesPing: "✅ Yes, ping them",
    yesCreate: "✅ Yes, create it",
    yesCancel: "✅ Yes, cancel it",
    yesEdit: "✅ Yes, update it",
    no: "✕ No",
    connect: "🤝 Connect",
    pass: "Pass",
    join: "🎟️ Join",
    edit: "✏️ Edit",
    cancelEvt: "🗑 Cancel",
  },
  menu:
    "Here's what I can do:\n" +
    "• find me a buddy — I pick one person worth meeting and can intro you\n" +
    '• find me <topic> — specific people (e.g. "find me a climate VC")\n' +
    "• create event — propose a meetup; I'll ping everyone who can come\n" +
    "• my events — edit or cancel an event you host\n" +
    "• who is here — quick look at who's in the circle\n" +
    "• what's on — see the upcoming events\n" +
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
  eventAnnounce: (a, withCta = true) =>
    [
      `${a.emoji} ${a.title}`,
      `${a.when} · ${a.place}`,
      `Organisé par ${a.hostName}.`,
      ...(a.description ? [a.description] : []),
      ...(withCta ? [`Répondez « join ${a.title} » pour vous inscrire.`] : []),
    ].join("\n"),
  introSent: (name) =>
    `Demande envoyée à ${name}. Je te préviens s'il/elle est partant·e.`,
  introRequest: (from, bio, opener, linkedinUrl, withCta = true) =>
    `${from}${bio ? ` (${bio})` : ""} veut se connecter 👋\n\n` +
    `« ${opener} »\n` +
    (linkedinUrl ? `\nSon profil : ${linkedinUrl}\n` : "") +
    (withCta ? `\nRéponds oui pour échanger vos contacts, ou non pour passer.` : ""),
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
  introBrowseNudge: "Envie d'une intro ? Réponds `intro me to` suivi de son nom.",
  contactReachesOut: (name) => `${name} (il/elle te recontactera)`,
  langPrompt:
    "Quelle langue ? Répondez english ou français.\n" +
    "Which language? Reply english or français.",
  langPromptShort: "Quelle langue ? · Which language?",
  langSet: (name) => `C'est noté — je te parle en ${name} désormais.`,
  rsvpJoined: (title, place, when, groupLink) =>
    [
      `✅ C'est confirmé, tu participes à « ${title} »`,
      place || when ? `📍 ${[place, when].filter(Boolean).join(" · ")}` : null,
      groupLink ? `Rejoins le groupe pour t'organiser : ${groupLink}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  rsvpNotFound:
    "Événement introuvable. Réponds « quoi de prévu » pour voir l'agenda.",
  rsvpAmbiguous:
    "Plusieurs événements correspondent — réponds « quoi de prévu » et utilise le titre exact.",
  rsvpOwnEvent: (title) =>
    `Tu organises « ${title} » — tu es déjà inscrit. Réponds \`mes événements\` pour le modifier ou l'annuler.`,
  rsvpStatusList: (lines) =>
    `✅ Oui — tu es inscrit à :\n${lines.map((l) => `• ${l}`).join("\n")}`,
  rsvpStatusNone:
    "Pas encore — tu n'es inscrit à aucun événement. Réponds « quoi de prévu » pour en choisir un.",
  rsvpStatusNotFor: (title) =>
    `Pas encore — tu n'es pas inscrit à « ${title} ». Réponds « quoi de prévu » pour le trouver.`,
  myEventsHeader: "Les événements que tu organises :",
  myEventsEmpty:
    "Tu n'organises encore aucun événement. Réponds `créer événement` pour en lancer un.",
  myEventsHint:
    "Réponds `modifier événement <titre>` ou `annuler événement <titre>` pour en gérer un.",
  whatsOnHeader: "Voici ce qui arrive :",
  whatsOnEmpty:
    "Rien au programme pour l'instant — envie d'être le premier ? Réponds `créer événement`.",
  whatsOnHint: "Réponds « join » + le nom de l'événement pour t'inscrire.",
  editPrompt: (title) =>
    `Modification de « ${title} ». Que veux-tu changer ? (ex. heure à 9h, lieu à Café X, cap 15, ou renommer). Réponds annuler pour arrêter.`,
  editNoChanges: "Rien n'a changé — l'événement reste tel quel.",
  notYourEvent: "Ce n'est pas un événement que tu organises, je ne peux pas le modifier.",
  ownedEventAmbiguous:
    "Tu organises plusieurs événements — réponds `mes événements` pour choisir lequel.",
  eventGone: "Cet événement n'est plus disponible.",
  cancelConfirm: (title, attendees) =>
    `Annuler « ${title} » ? ` +
    (attendees > 0
      ? `Je préviendrai ${attendees} ${attendees === 1 ? "personne inscrite" : "personnes inscrites"}. `
      : "") +
    "Réponds oui pour confirmer.",
  eventCancelled: (title, notified) =>
    `✓ « ${title} » annulé` +
    (notified > 0 ? ` — ${notified} ${notified === 1 ? "personne prévenue" : "personnes prévenues"}` : "") +
    ".",
  eventAlreadyCancelled: (title) => `« ${title} » était déjà annulé.`,
  cantCancelOngoing: (title) =>
    `« ${title} » est déjà en cours, je ne peux donc plus l'annuler. Tu peux encore en modifier les détails si besoin.`,
  eventCancelledNotice: (title, hostName) =>
    `Info — « ${title} »${hostName ? ` (organisé par ${hostName})` : ""} a été annulé. ✕`,
  eventUpdated: (title, notified) =>
    `✓ « ${title} » mis à jour` +
    (notified > 0 ? ` — ${notified} ${notified === 1 ? "personne prévenue" : "personnes prévenues"}` : "") +
    ".",
  eventUpdatedNotice: (a) =>
    [
      `Changement sur « ${a.title} » 🔄`,
      [a.when, a.place].filter(Boolean).join(" · "),
      a.hostName ? `Organisé par ${a.hostName}.` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  eventReminder: (title, when, place) =>
    [
      `⏰ Rappel : « ${title} » approche`,
      [when, place].filter(Boolean).join(" · ") || null,
      "À très vite !",
    ]
      .filter(Boolean)
      .join("\n"),
  tribeReady: (link) => `🎪 Groupe de discussion prêt — partage-le aux participants : ${link}`,
  otUsernamePrompt:
    "Dernière chose — quel est ton nom d'utilisateur Online Tribes ? Je crée un groupe de discussion pour cet événement, dont tu seras propriétaire. " +
    "Pas encore de compte ? Crée-en un sur https://online-tribes.com, puis reviens répondre ton nom d'utilisateur. (Ou réponds skip.)",
  otUsernameConfirm: (handle, name) =>
    `Utilisateur Online Tribes trouvé : @${handle}${name && name !== handle ? ` (${name})` : ""}. ` +
    `Créer le groupe sous ce compte ? Réponds oui, envoie un autre identifiant, ou réponds skip.`,
  otUsernameNotFound:
    "Nom d'utilisateur Online Tribes introuvable. Vérifie-le (ou inscris-toi sur online-tribes.com) et renvoie-le — ou réponds skip pour ajouter le groupe plus tard.",
  otUsernameSkipped:
    "Pas de souci — ton événement est en ligne. Tu pourras ajouter un groupe Online Tribes plus tard.",
  otUsernameError:
    "Impossible de créer le groupe pour le moment — ton événement est en ligne ; on réglera le groupe plus tard.",
  btn: {
    yesPing: "✅ Oui, préviens-le/la",
    yesCreate: "✅ Oui, créer",
    yesCancel: "✅ Oui, annuler",
    yesEdit: "✅ Oui, modifier",
    no: "✕ Non",
    connect: "🤝 Se connecter",
    pass: "Passer",
    join: "🎟️ Participer",
    edit: "✏️ Modifier",
    cancelEvt: "🗑 Annuler",
  },
  menu:
    "Voici ce que je peux faire :\n" +
    "• trouve-moi un binôme — je choisis une personne à rencontrer et je peux vous présenter\n" +
    "• trouve-moi <sujet> — des personnes précises (ex. « trouve-moi un VC climat »)\n" +
    "• créer événement — propose un rendez-vous ; je préviens ceux que ça intéresse\n" +
    "• mes événements — modifier ou annuler un événement que tu organises\n" +
    "• qui est là — un aperçu du cercle\n" +
    "• quoi de prévu — voir les événements à venir\n" +
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
