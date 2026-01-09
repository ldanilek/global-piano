import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";

/**
 * Record a note attack (key down) - syncs to all users playing the global piano.
 */
export const playNote = mutation({
  args: {
    note: v.string(),
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("noteEvents", {
      note: args.note,
      sessionId: args.sessionId,
      action: "attack",
      timestamp: Date.now(),
    });
    await cleanupOldEvents(ctx);
  },
});

/**
 * Record a note release (key up) - syncs to all users playing the global piano.
 */
export const releaseNote = mutation({
  args: {
    note: v.string(),
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("noteEvents", {
      note: args.note,
      sessionId: args.sessionId,
      action: "release",
      timestamp: Date.now(),
    });
    await cleanupOldEvents(ctx);
  },
});

/**
 * Get recent note events for real-time sync.
 * All users subscribe to this query - when it updates, they play/release notes from other sessions.
 */
export const getNoteEvents = query({
  args: {},
  handler: async (ctx) => {
    // Last 30 seconds of events - enough for real-time sync
    const cutoff = Date.now() - 30 * 1000;
    return await ctx.db
      .query("noteEvents")
      .withIndex("by_timestamp")
      .filter((q) => q.gte(q.field("timestamp"), cutoff))
      .order("asc") // Chronological order for playback
      .take(200);
  },
});

async function cleanupOldEvents(ctx: MutationCtx) {
  const cutoff = Date.now() - 2 * 60 * 1000; // Keep last 2 minutes
  const oldEvents = await ctx.db
    .query("noteEvents")
    .withIndex("by_timestamp")
    .filter((q) => q.lt(q.field("timestamp"), cutoff))
    .collect();

  for (const event of oldEvents) {
    await ctx.db.delete(event._id);
  }
}
