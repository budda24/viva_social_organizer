/**
 * Focused regression test for the button-driven `find me <topic>` flow + the
 * fallback-menu quick buttons (the "always buttons, not typed triggers" change).
 *
 * Asserts the pure helpers the brain uses to staple Telegram tap-buttons:
 *   1. introTopicFrom strips the verb + leading article ("find me a climate VC"
 *      → "climate VC") so the opener/callback_data name the topic cleanly;
 *   2. buildIntroButtons finds directory members named in the model's reply,
 *      in order, deduped, capped at 3, emits `introto <uid> <topic>` within the
 *      64-byte callback_data cap, and labels them "🤝 Intro: <Name>";
 *   3. INTROTO_BTN_RE parses the tapped data back into uid + topic;
 *   4. stripIntroNudge removes the typed "reply `intro me to`" nudge (for the
 *      Telegram body where buttons replace it) but leaves the suggestions;
 *   5. isMenuReply detects the fallback menu and menuButtons returns the 4
 *      canonical-English quick actions.
 *
 * Pure (no Firestore) — run: npx tsx src/test-intro-buttons.ts
 */
import {
  INTROTO_BTN_RE,
  buildIntroButtons,
  introTopicFrom,
  isMenuReply,
  menuButtons,
  stripIntroNudge,
  type DirectoryMember,
} from "./brain.js";
import { msg } from "./i18n.js";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${detail}`}`);
}

const member = (uid: string, name: string): DirectoryMember =>
  ({ uid, name } as DirectoryMember);

// 1 — topic extraction
check(`introTopicFrom("find me a climate VC")`, introTopicFrom("find me a climate VC") === "climate VC", introTopicFrom("find me a climate VC"));
check(`introTopicFrom("find me an AI researcher")`, introTopicFrom("find me an AI researcher") === "AI researcher");
check(`introTopicFrom("find me fintech founders")`, introTopicFrom("find me fintech founders") === "fintech founders");

// 2 — buttons from a browse reply naming two of three members
const members = [
  member("uidSarah000000000000000000aa", "Sarah Chen"),
  member("uidOmar0000000000000000000bb", "Omar Haddad"),
  member("uidNeverNamed00000000000ccc", "Lin Wei"),
];
const reply =
  "Omar Haddad runs a climate fund — great for your raise. Sarah Chen invests in early climate too. Want an intro? Reply `intro me to` and their name.";
const btns = buildIntroButtons(reply, members, "en", introTopicFrom("find me a climate VC"));
check("buildIntroButtons: 2 buttons (named members only)", btns.length === 2, `got ${btns.length}`);
check("buildIntroButtons: ordered by appearance (Omar before Sarah)", btns[0]?.text.includes("Omar") && btns[1]?.text.includes("Sarah"), btns.map((b) => b.text).join(" | "));
check("buildIntroButtons: label uses Intro prefix", btns[0]?.text.startsWith(msg("en").btn.introTo), btns[0]?.text);
check("buildIntroButtons: data is introto <uid> <topic>", btns[0]?.data === "introto uidOmar0000000000000000000bb climate VC", btns[0]?.data);
check("buildIntroButtons: never names an unmentioned member", !btns.some((b) => b.text.includes("Lin")), btns.map((b) => b.text).join(" | "));
check("buildIntroButtons: all data within 64 bytes", btns.every((b) => b.data.length <= 64), btns.map((b) => `${b.data}=${b.data.length}`).join(" | "));

// cap at 3 + dedup (same member named twice counts once)
const many = [
  member("u1", "Ann"),
  member("u2", "Bob"),
  member("u3", "Cy"),
  member("u4", "Dee"),
];
const manyReply = "Ann, Bob, Cy and Dee are all here. Ann again.";
const manyBtns = buildIntroButtons(manyReply, many, "en", "x");
check("buildIntroButtons: capped at 3", manyBtns.length === 3, `got ${manyBtns.length}`);
check("buildIntroButtons: deduped", new Set(manyBtns.map((b) => b.data)).size === 3);

// long topic truncates so `introto <uid> <topic>` fits 64 bytes
const longTopic = "a".repeat(80);
const longBtns = buildIntroButtons("Ann is here.", [member("u1", "Ann")], "en", longTopic);
check("buildIntroButtons: long topic truncated to ≤64", longBtns[0]!.data.length <= 64, `${longBtns[0]!.data.length}`);

// 3 — the webhook routes the tapped data back as a body; the brain re-parses it
const m = "introto uidOmar0000000000000000000bb climate VC".match(INTROTO_BTN_RE);
check("INTROTO_BTN_RE: parses uid", m?.[1] === "uidOmar0000000000000000000bb", m?.[1]);
check("INTROTO_BTN_RE: parses topic", m?.[2] === "climate VC", m?.[2]);
check("INTROTO_BTN_RE: works without a topic", !!"introto uidX".match(INTROTO_BTN_RE));
check("INTROTO_BTN_RE: ignores unrelated text", !"find me a climate vc".match(INTROTO_BTN_RE));

// 4 — Telegram body drops the typed nudge but keeps the suggestions
const stripped = stripIntroNudge(reply);
check("stripIntroNudge: drops the typed nudge", !/intro me to/i.test(stripped), stripped);
check("stripIntroNudge: keeps the suggestions", stripped.includes("Omar Haddad") && stripped.includes("Sarah Chen"), stripped);
const frNudge = "Sarah Chen est parfaite. Envie d'une intro ? Réponds `intro me to` suivi de son nom.";
check("stripIntroNudge: handles the FR nudge", !/intro me to/i.test(stripIntroNudge(frNudge)), stripIntroNudge(frNudge));

// 5 — fallback-menu detection + quick buttons
check("isMenuReply: true for the EN menu", isMenuReply(msg("en").menu, "en"));
check("isMenuReply: true for the FR menu", isMenuReply(msg("fr").menu, "fr"));
check("isMenuReply: false for an ordinary reply", !isMenuReply("Sarah Chen is a great match.", "en"));
const menu = menuButtons("en");
check("menuButtons: 4 buttons", menu.length === 4, `got ${menu.length}`);
const datas = menu.map((b) => b.data);
check("menuButtons: canonical English commands", JSON.stringify(datas) === JSON.stringify(["find me a buddy", "what's on", "create event", "who is here"]), datas.join(" | "));

console.log(failures === 0 ? "\nALL PASS ✅" : `\n${failures} FAILURE(S) ✗`);
process.exit(failures === 0 ? 0 : 1);
