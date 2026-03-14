import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  noteHolds: defineTable({
    sessionId: v.string(),
    pointerId: v.string(),
    note: v.string(),
  }).index("by_session_pointer", ["sessionId", "pointerId"]),

  sessionActivity: defineTable({
    sessionId: v.string(),
    lastActive: v.number(),
  }).index("by_session", ["sessionId"]),

  /**
   * Append-only log of every press / release / glide move (for analytics & debugging).
   */
  pianoEventLog: defineTable({
    timestamp: v.number(),
    sessionId: v.string(),
    pointerId: v.string(),
    kind: v.union(
      v.literal("press"),
      v.literal("release"),
      v.literal("move"),
      v.literal("session_expired")
    ),
    /** Set for press (target note) and release (note that was held). */
    note: v.optional(v.string()),
    fromNote: v.optional(v.string()),
    toNote: v.optional(v.string()),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_session", ["sessionId"]),
});
