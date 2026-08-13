import { z } from "zod";
import { performerOrder } from "./performers.js";

export const songStatusSchema = z.enum([
  "active",
  "favorite",
  "practicing",
  "hold",
  "deletion_candidate",
  "deleted"
]);

export const userRoleSchema = z.enum(["owner", "editor"]);
export const performerIdSchema = z.enum(performerOrder);

export const keyCandidateSchema = z.object({
  id: z.string().min(1),
  baseMode: z.enum(["original", "male", "female", "custom"]),
  offset: z.number().int().min(-12).max(12),
  label: z.string().trim().max(40).default(""),
  memo: z.string().trim().max(500).default(""),
  isPrimary: z.boolean().default(false)
});

export const songSchema = z.object({
  id: z.string().min(1),
  tjNumber: z.string().trim().regex(/^\d*$/).optional().default(""),
  title: z.string().trim().min(1).max(300),
  titleReadingKo: z.string().trim().max(300).optional().default(""),
  titleRomanized: z.string().trim().max(300).optional().default(""),
  titleAliases: z.array(z.string().trim().max(160)).default([]),
  artist: z.string().trim().min(1).max(300),
  artistReadingKo: z.string().trim().max(300).optional().default(""),
  artistAliases: z.array(z.string().trim().max(160)).default([]),
  country: z.string().trim().max(80).optional().default(""),
  genres: z.array(z.string().trim().max(80)).default([]),
  originalWork: z.string().trim().max(200).optional().default(""),
  keyCandidates: z.array(keyCandidateSchema).default([]),
  performerIds: z.array(performerIdSchema).default([]).transform((ids) => Array.from(new Set(ids))),
  memo: z.string().trim().max(2000).optional().default(""),
  status: songStatusSchema.default("active"),
  youtubeUrl: z.string().trim().url().or(z.literal("")).optional().default(""),
  youtubeVideoId: z.string().trim().max(40).optional().default(""),
  isOfficialTjVideo: z.boolean().nullable().default(null),
  sourceType: z.string().trim().max(80).optional().default(""),
  sourceReference: z.string().trim().max(300).optional().default(""),
  createdByName: z.string().trim().max(80).optional().default(""),
  createdAt: z.string().trim().optional().default(""),
  updatedByName: z.string().trim().max(80).optional().default(""),
  updatedAt: z.string().trim().optional().default(""),
  deletedAt: z.string().trim().optional().default(""),
  version: z.number().int().nonnegative().default(1),
  lastPerformedAt: z.string().trim().optional().default(""),
  performanceCount: z.number().int().nonnegative().default(0)
}).superRefine((song, ctx) => {
  const primaryCount = song.keyCandidates.filter((key) => key.isPrimary).length;
  if (primaryCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "primary key candidate must be unique",
      path: ["keyCandidates"]
    });
  }
});

export const performanceSchema = z.object({
  id: z.string().min(1),
  songId: z.string().min(1),
  performedAt: z.string().min(1),
  keySelection: keyCandidateSchema.partial().nullable().default(null),
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

export type SongStatus = z.infer<typeof songStatusSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
export type KeyCandidate = z.infer<typeof keyCandidateSchema>;
export type Song = z.infer<typeof songSchema>;
export type Performance = z.infer<typeof performanceSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type PublicData = z.infer<typeof publicDataSchema>;
