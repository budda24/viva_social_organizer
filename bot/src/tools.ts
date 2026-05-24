/**
 * Anthropic tool definitions for the bot brain.
 * Stub — filled in alongside brain.ts when the full Claude tool-use loop lands.
 *
 * Each tool follows Anthropic's tool-use JSON schema. The handler reads from
 * or writes to Firestore via the Admin SDK. Side-effecting tools that touch
 * other members MUST first call requestConfirmation and wait for `yes`.
 */

import type Anthropic from "@anthropic-ai/sdk";

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "readUser",
    description: "Read a member's profile by uid.",
    input_schema: {
      type: "object",
      properties: { uid: { type: "string" } },
      required: ["uid"],
    },
  },
  {
    name: "readEvents",
    description: "List upcoming published events. Optional filter by kind.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["breakfast", "coffee", "drinks", "dinner", "rooftop", "walk", "side-event"],
        },
        afterIso: { type: "string", description: "ISO timestamp lower bound" },
      },
    },
  },
  {
    name: "writeFreeUntil",
    description: "Set the current user's freeUntil timestamp.",
    input_schema: {
      type: "object",
      properties: {
        uid: { type: "string" },
        minutes: { type: "number" },
      },
      required: ["uid", "minutes"],
    },
  },
  {
    name: "requestConfirmation",
    description:
      "Ask the user to confirm a side effect (create event, send intro, RSVP). " +
      "Must be called before any mutating tool that touches other members.",
    input_schema: {
      type: "object",
      properties: {
        proposal: { type: "string", description: "What you're about to do, in user-facing language" },
      },
      required: ["proposal"],
    },
  },
  {
    name: "sendReply",
    description:
      "Send the final reply to the user via WhatsApp. Always end the turn with this. " +
      "Keep <=280 chars, <=2 emojis, <=1 exclamation mark.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];
