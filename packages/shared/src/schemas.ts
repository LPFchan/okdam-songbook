import { z } from "zod";
import { performerOrder } from "./performers.js";

export const userRoleSchema = z.literal("allowed");
export const performerIdSchema = z.enum(performerOrder);

export const recommendedKeySchema = z.object({
  baseMode: z.enum(["original", "male", "female"]),
  offset: z.number().int().min(-12).max(12)
});

export const songSchema = z.object({
  id: z.string().min(1),
  tjNumber: z.string().trim().regex(/^\d*$/).optional().default(""),
  title: z.string().trim().min(1).max(300),
  titleReadingKo: z.string().trim().max(300).optional().default(""),
  artist: z.string().trim().min(1).max(300),
  artistReadingKo: z.string().trim().max(300).optional().default(""),
  country: z.string().trim().max(80).optional().default(""),
  recommendedKey: recommendedKeySchema.nullable().default(null),
  performerIds: z.array(performerIdSchema).default([]).transform((ids) => Array.from(new Set(ids))),
  memo: z.string().trim().max(4000).optional().default(""),
  sourceType: z.string().trim().max(80).optional().default(""),
  sourceReference: z.string().trim().max(300).optional().default(""),
  createdByName: z.string().trim().max(80).optional().default(""),
  createdAt: z.string().trim().optional().default(""),
  updatedByName: z.string().trim().max(80).optional().default(""),
  updatedAt: z.string().trim().optional().default(""),
  deletedAt: z.string().trim().optional().default(""),
  version: z.number().int().nonnegative().default(1),
  lastPerformedAt: z.string().trim().optional().default(""),
  lastPerformedByName: z.string().trim().max(80).optional(),
  performanceCount: z.number().int().nonnegative().default(0)
});

export const performanceSchema = z.object({
  id: z.string().min(1),
  songId: z.string().min(1),
  performedAt: z.string().min(1),
  keySelection: recommendedKeySchema.nullable().default(null),
  memo: z.string().trim().max(1000).optional().default(""),
  createdByName: z.string().trim().max(80).optional().default(""),
  createdAt: z.string().trim().optional().default(""),
  cancelledAt: z.string().trim().optional().default(""),
  clientRequestId: z.string().min(1),
  version: z.number().int().nonnegative().default(1)
});

export const currentUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  role: userRoleSchema
});

export const favoriteListSchema = z.object({
  songIds: z.array(z.string().min(1))
});

export const favoriteSetRequestSchema = z.object({
  songId: z.string().min(1),
  favorite: z.boolean(),
  clientRequestId: z.string().uuid()
});

export const favoriteSetResultSchema = z.object({
  songId: z.string().min(1),
  favorite: z.boolean()
});

export const publicDataSchema = z.object({
  songs: z.array(songSchema),
  serverVersion: z.string().min(1),
  updatedAt: z.string().min(1)
});

export const apiErrorSchema = z.object({
  code: z.enum([
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "DUPLICATE_TJ_NUMBER",
    "VALIDATION_ERROR",
    "RATE_LIMITED",
    "AI_NOT_CONFIGURED",
    "EXTERNAL_API_ERROR",
    "TJ_UPSTREAM_ERROR",
    "TJ_PARSER_ERROR",
    "TJ_RATE_LIMITED",
    "SHEET_SCHEMA_ERROR",
    "INTERNAL_ERROR"
  ]),
  message: z.string(),
  details: z.unknown().nullable().default(null)
});

export const apiResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().nullable(),
  error: apiErrorSchema.nullable(),
  requestId: z.string().min(1),
  serverTime: z.string().min(1)
});

export type UserRole = z.infer<typeof userRoleSchema>;
export type RecommendedKey = z.infer<typeof recommendedKeySchema>;
export type Song = z.infer<typeof songSchema>;
export type Performance = z.infer<typeof performanceSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type FavoriteList = z.infer<typeof favoriteListSchema>;
export type FavoriteSetRequest = z.infer<typeof favoriteSetRequestSchema>;
export type FavoriteSetResult = z.infer<typeof favoriteSetResultSchema>;
export type PublicData = z.infer<typeof publicDataSchema>;
