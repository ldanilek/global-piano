import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";

const STALE_SESSION_MS = 2 * 60 * 1000;

/** Single-codepoint / common emoji picks only — server validates so clients can't send arbitrary strings */
const SESSION_EMOJI_ALLOWLIST = new Set([
  "🎹", "🎵", "🎶", "🎤", "🎧", "🎸", "🎺", "🎻", "🥁", "🎷",
  "🐱", "🐶", "🦊", "🐻", "🐼", "🦁", "🐸", "🦄", "🐝", "🦋",
  "⭐", "🌙", "☀️", "🌈", "🔥", "💧", "🌊", "🍀", "🌸", "🍄",
  "🎮", "🚀", "✨", "💫", "❤️", "💜", "💙", "💚", "🧡", "🤍",
  "🎪", "🎭", "🎨", "🍕", "🍦", "☕", "🌮", "🍎", "🐙", "🦀",
  "👽", "🤖", "💎", "⚡", "🎲", "🏀", "⚽", "🎯", "📌", "🔔",
]);

function assertAllowedEmoji(emoji: string): void {
  if (!SESSION_EMOJI_ALLOWLIST.has(emoji)) {
    throw new Error("Pick an emoji from the list");
  }
}

async function logEvent(
  ctx: MutationCtx,
  row: {
    sessionId: string;
    pointerId: string;
    kind: "press" | "release" | "move" | "session_expired";
    note?: string;
    fromNote?: string;
    toNote?: string;
  }
): Promise<void> {
  await ctx.db.insert("pianoEventLog", {
    timestamp: Date.now(),
    ...row,
  });
}

async function cleanupStaleSessions(ctx: MutationCtx): Promise<void> {
  const cutoff = Date.now() - STALE_SESSION_MS;
  const stale = await ctx.db
    .query("sessionActivity")
    .withIndex("by_lastActive", (q) => q.lt("lastActive", cutoff))
    .collect();

  for (const row of stale) {
    const holds = await sessionHolds(ctx, row.sessionId);
    for (const h of holds) {
      await logEvent(ctx, {
        sessionId: h.sessionId,
        pointerId: h.pointerId,
        kind: "session_expired",
        note: h.note,
      });
      await ctx.db.delete(h._id);
    }
    const profile = await ctx.db
      .query("sessionProfiles")
      .withIndex("by_session", (q) => q.eq("sessionId", row.sessionId))
      .unique();
    if (profile) {
      await ctx.db.delete(profile._id);
    }
    await ctx.db.delete(row._id);
  }
}

async function touchSession(ctx: MutationCtx, sessionId: string): Promise<void> {
  const now = Date.now();
  const existing = await ctx.db
    .query("sessionActivity")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, { lastActive: now });
  } else {
    await ctx.db.insert("sessionActivity", { sessionId, lastActive: now });
  }
}

async function getHoldForPointer(
  ctx: MutationCtx,
  sessionId: string,
  pointerId: string
) {
  return await ctx.db
    .query("noteHolds")
    .withIndex("by_session_pointer", (q) =>
      q.eq("sessionId", sessionId).eq("pointerId", pointerId)
    )
    .unique();
}

async function sessionHolds(ctx: MutationCtx, sessionId: string) {
  return await ctx.db
    .query("noteHolds")
    .withIndex("by_session_pointer", (q) => q.eq("sessionId", sessionId))
    .collect();
}

export const setSessionProfile = mutation({
  args: {
    sessionId: v.string(),
    emoji: v.string(),
  },
  handler: async (ctx, args) => {
    assertAllowedEmoji(args.emoji);
    await cleanupStaleSessions(ctx);
    const existing = await ctx.db
      .query("sessionProfiles")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { emoji: args.emoji });
    } else {
      await ctx.db.insert("sessionProfiles", {
        sessionId: args.sessionId,
        emoji: args.emoji,
      });
    }
    await touchSession(ctx, args.sessionId);
  },
});

/**
 * Replace all keyboard holds (pointerId key_*) for this session in one transaction.
 * Avoids lost keys when many pressNote mutations overlap (each read old snapshot).
 */
export const syncKeyboardHolds = mutation({
  args: {
    sessionId: v.string(),
    holds: v.array(v.object({ pointerId: v.string(), note: v.string() })),
  },
  handler: async (ctx, args) => {
    if (args.holds.length > 48) {
      throw new Error("Too many keyboard holds");
    }
    const pidSet = new Set<string>();
    for (const h of args.holds) {
      if (!h.pointerId.startsWith("key_")) {
        throw new Error("Keyboard holds must use key_* pointerIds");
      }
      if (pidSet.has(h.pointerId)) {
        throw new Error("Duplicate pointerId");
      }
      pidSet.add(h.pointerId);
    }

    await cleanupStaleSessions(ctx);
    await touchSession(ctx, args.sessionId);

    const all = await sessionHolds(ctx, args.sessionId);
    const oldK = all.filter((row) => row.pointerId.startsWith("key_"));
    const oldMap = new Map(oldK.map((row) => [row.pointerId, row.note]));
    const newMap = new Map(args.holds.map((h) => [h.pointerId, h.note]));

    for (const [pointerId, note] of oldMap) {
      if (newMap.get(pointerId) !== note) {
        await logEvent(ctx, {
          sessionId: args.sessionId,
          pointerId,
          kind: "release",
          note,
        });
      }
    }
    for (const [pointerId, note] of newMap) {
      if (oldMap.get(pointerId) !== note) {
        await logEvent(ctx, {
          sessionId: args.sessionId,
          pointerId,
          kind: "press",
          note,
        });
      }
    }

    for (const row of oldK) {
      await ctx.db.delete(row._id);
    }
    for (const h of args.holds) {
      await ctx.db.insert("noteHolds", {
        sessionId: args.sessionId,
        pointerId: h.pointerId,
        note: h.note,
      });
    }
  },
});

export const pressNote = mutation({
  args: {
    note: v.string(),
    sessionId: v.string(),
    pointerId: v.string(),
  },
  handler: async (ctx, args) => {
    await cleanupStaleSessions(ctx);
    await touchSession(ctx, args.sessionId);
    const existing = await getHoldForPointer(ctx, args.sessionId, args.pointerId);
    if (existing?.note === args.note) return;
    if (existing) {
      await logEvent(ctx, {
        sessionId: args.sessionId,
        pointerId: args.pointerId,
        kind: "move",
        fromNote: existing.note,
        toNote: args.note,
      });
      await ctx.db.delete(existing._id);
    } else {
      await logEvent(ctx, {
        sessionId: args.sessionId,
        pointerId: args.pointerId,
        kind: "press",
        note: args.note,
      });
    }
    await ctx.db.insert("noteHolds", {
      sessionId: args.sessionId,
      pointerId: args.pointerId,
      note: args.note,
    });
  },
});

export const releasePointer = mutation({
  args: {
    sessionId: v.string(),
    pointerId: v.string(),
  },
  handler: async (ctx, args) => {
    await cleanupStaleSessions(ctx);
    await touchSession(ctx, args.sessionId);
    const existing = await getHoldForPointer(ctx, args.sessionId, args.pointerId);
    if (existing) {
      await logEvent(ctx, {
        sessionId: args.sessionId,
        pointerId: args.pointerId,
        kind: "release",
        note: existing.note,
      });
      await ctx.db.delete(existing._id);
    }
  },
});

export const moveNote = mutation({
  args: {
    sessionId: v.string(),
    pointerId: v.string(),
    fromNote: v.string(),
    toNote: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.fromNote === args.toNote) return;
    await cleanupStaleSessions(ctx);
    await touchSession(ctx, args.sessionId);
    const existing = await getHoldForPointer(ctx, args.sessionId, args.pointerId);
    if (!existing || existing.note !== args.fromNote) {
      if (existing) {
        await ctx.db.delete(existing._id);
      }
      await ctx.db.insert("noteHolds", {
        sessionId: args.sessionId,
        pointerId: args.pointerId,
        note: args.toNote,
      });
      await logEvent(ctx, {
        sessionId: args.sessionId,
        pointerId: args.pointerId,
        kind: "move",
        fromNote: existing?.note ?? args.fromNote,
        toNote: args.toNote,
      });
      return;
    }
    await ctx.db.patch(existing._id, { note: args.toNote });
    await logEvent(ctx, {
      sessionId: args.sessionId,
      pointerId: args.pointerId,
      kind: "move",
      fromNote: args.fromNote,
      toNote: args.toNote,
    });
  },
});

export const getHolds = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("noteHolds").collect();
  },
});

export const getPianoState = query({
  args: {},
  handler: async (ctx) => {
    const holds = await ctx.db.query("noteHolds").collect();
    const sessionIds = [...new Set(holds.map((h) => h.sessionId))];
    const emojiBySession: Record<string, string> = {};
    for (const sid of sessionIds) {
      const p = await ctx.db
        .query("sessionProfiles")
        .withIndex("by_session", (q) => q.eq("sessionId", sid))
        .unique();
      emojiBySession[sid] = p?.emoji ?? "🎹";
    }
    return { holds, emojiBySession };
  },
});

/** Recent log entries, newest first (for dashboards / debugging). */
export const listEventLog = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const n = Math.min(Math.max(1, args.limit ?? 200), 1000);
    return await ctx.db
      .query("pianoEventLog")
      .withIndex("by_timestamp")
      .order("desc")
      .take(n);
  },
});
