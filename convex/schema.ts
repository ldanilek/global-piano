import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Schema for the global piano.
 * Stores note play/release events so all users share the same piano in real-time.
 */
export default defineSchema({
  // Note events: attack (key down) and release (key up)
  // Each user has a sessionId to distinguish their own plays from others
  noteEvents: defineTable({
    note: v.string(), // e.g., "C4", "F#3"
    sessionId: v.string(), // Unique ID for each browser session
    action: v.union(v.literal("attack"), v.literal("release")),
    timestamp: v.number(),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_session", ["sessionId"]),
});
