import { z } from "zod";
import { damSongCandidateSchema } from "./dam.js";
import { performerIdSchema } from "./schemas.js";
import { tjSongCandidateSchema } from "./tj.js";

export const recommendationRoleSchema = z.enum(["artist", "composer", "lyricist"]);

export const recommendationRequestSchema = z.object({
  performerIds: z.array(performerIdSchema).min(1),
  system: z.enum(["tj", "dam"])
});

/** One person behind the performers' saved songs, and what TJ or DAM has by them. */
export const recommendationGroupSchema = z.object({
  name: z.string(),
  role: recommendationRoleSchema,
  songCount: z.number().int().positive(),
  candidates: z.array(z.union([tjSongCandidateSchema, damSongCandidateSchema])),
  error: z.string().nullable()
});

export const recommendationResultSchema = z.object({
  groups: z.array(recommendationGroupSchema)
});

export type RecommendationRole = z.infer<typeof recommendationRoleSchema>;
export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>;
export type RecommendationGroup = z.infer<typeof recommendationGroupSchema>;
