import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";

export const gameSessions = pgTable("game_sessions", {
  id: serial("id").primaryKey(),
  title: text("title").notNull().default("Adventure"),
  genre: text("genre").notNull().default("fantasy"),
  status: text("status").notNull().default("active"),
  turnCount: integer("turn_count").notNull().default(0),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const storyEntries = pgTable("story_entries", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => gameSessions.id, { onDelete: "cascade" }),
  entryType: text("entry_type").notNull(),
  content: text("content").notNull(),
  choiceIndex: integer("choice_index"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertGameSessionSchema = createInsertSchema(gameSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  turnCount: true,
});

export const insertStoryEntrySchema = createInsertSchema(storyEntries).omit({
  id: true,
  createdAt: true,
});

export type GameSession = typeof gameSessions.$inferSelect;
export type InsertGameSession = z.infer<typeof insertGameSessionSchema>;
export type StoryEntry = typeof storyEntries.$inferSelect;
export type InsertStoryEntry = z.infer<typeof insertStoryEntrySchema>;
