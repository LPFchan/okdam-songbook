import { z } from "zod";
import { damSongCandidateSchema } from "./dam.js";
import { performerIdSchema } from "./schemas.js";
import { tjSongCandidateSchema } from "./tj.js";

export const recommendationRequestSchema = z.object({
  performerIds: z.array(performerIdSchema).min(1),
  system: z.enum(["tj", "dam"]),
  /**
   * Artists the client already shows. The next page is the five best-ranked
   * artists not in this list, so catalog edits between pages never skip or
   * repeat anyone.
   */
  exclude: z.array(z.string().max(300)).max(1_000).default([])
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
  /** Whether more artists remain after this page. */
  hasMore: z.boolean()
});

export type RecommendationRequest = z.input<typeof recommendationRequestSchema>;
export type RecommendationResult = z.infer<typeof recommendationResultSchema>;
export type RecommendationGroup = z.infer<typeof recommendationGroupSchema>;
