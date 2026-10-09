import { z } from "zod";
import { damSongCandidateSchema } from "./dam.js";
import { performerIdSchema } from "./schemas.js";
import { tjSongCandidateSchema } from "./tj.js";

export const recommendationRequestSchema = z.object({
  performerIds: z.array(performerIdSchema).min(1),
  system: z.enum(["tj", "dam"]),
  /** Rank of the first artist to return; pages hold five artists. */
  offset: z.number().int().min(0).default(0)
});

/** One artist behind the performers' saved songs, and what TJ or DAM has by them. */
export const recommendationGroupSchema = z.object({
  name: z.string(),
  songCount: z.number().int().positive(),
  candidates: z.array(z.union([tjSongCandidateSchema, damSongCandidateSchema])),
  error: z.string().nullable()
});

export const recommendationResultSchema = z.object({
  groups: z.array(recommendationGroupSchema),
  /** Offset of the next page, or null after the last artist. */
  nextOffset: z.number().int().min(0).nullable()
});

export type RecommendationRequest = z.input<typeof recommendationRequestSchema>;
export type RecommendationResult = z.infer<typeof recommendationResultSchema>;
export type RecommendationGroup = z.infer<typeof recommendationGroupSchema>;
