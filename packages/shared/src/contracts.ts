import { z } from "zod";
import {
  currentUserSchema,
  performanceSchema,
  publicDataSchema,
  songSchema,
  userRoleSchema
} from "./schemas.js";
import {
  tjAddResultSchema,
  tjLookupRequestSchema,
  tjLookupResultSchema,
  tjSearchRequestSchema,
  tjSearchResultSchema,
  tjSongCandidateSchema
} from "./tj.js";

/** The public-read policy for the single-origin application. */
export const publicReadPolicy = "anonymous" as const;

export const apiErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "DUPLICATE_TJ_NUMBER",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "EXTERNAL_API_ERROR",
  "TJ_UPSTREAM_ERROR",
  "TJ_PARSER_ERROR",
  "TJ_RATE_LIMITED",
  "AI_NOT_CONFIGURED",
  "SHEET_SCHEMA_ERROR",
  "INTERNAL_ERROR"
]);

export const apiErrorContractSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
  details: z.unknown().nullable().default(null)
});

export const apiEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().nullable(),
  error: apiErrorContractSchema.nullable(),
  requestId: z.string().min(1),
  serverTime: z.string().datetime({ offset: true })
});

export const apiSuccessSchema = <T extends z.ZodTypeAny>(data: T) => z.object({
  ok: z.literal(true),
  data,
  error: z.null(),
  requestId: z.string().min(1),
  serverTime: z.string().datetime({ offset: true })
});

export const apiFailureSchema = z.object({
  ok: z.literal(false),
  data: z.null(),
  error: apiErrorContractSchema,
  requestId: z.string().min(1),
  serverTime: z.string().datetime({ offset: true })
});

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiErrorContract = z.infer<typeof apiErrorContractSchema>;
export type ApiEnvelope = z.infer<typeof apiEnvelopeSchema>;

export const catalogResponseSchema = apiSuccessSchema(publicDataSchema);
export const currentUserResponseSchema = apiSuccessSchema(currentUserSchema);

export const catalogRouteSchema = z.object({
  method: z.literal("GET"),
  path: z.literal("/api/catalog"),
  authentication: z.literal("anonymous")
});

export const currentUserRouteSchema = z.object({
  method: z.literal("GET"),
  path: z.literal("/api/me"),
  authentication: z.literal("allowed-session")
});

const protectedBrowserRoute = z.literal("allowed-session");

export const performanceCreateRouteSchema = z.object({
  method: z.literal("POST"),
  path: z.literal("/api/performances"),
  authentication: protectedBrowserRoute
});

export const performanceCancelRouteSchema = z.object({
  method: z.literal("DELETE"),
  path: z.literal("/api/performances/:id"),
  authentication: protectedBrowserRoute
});

export const songCreateRouteSchema = z.object({
  method: z.literal("POST"),
  path: z.literal("/api/songs"),
  authentication: protectedBrowserRoute
});

export const songUpdateRouteSchema = z.object({
  method: z.literal("PATCH"),
  path: z.literal("/api/songs/:id"),
  authentication: protectedBrowserRoute
});

export const songDeleteRouteSchema = z.object({
  method: z.literal("DELETE"),
  path: z.literal("/api/songs/:id"),
  authentication: protectedBrowserRoute
});

export const songDeleteActionRouteSchema = z.object({
  method: z.literal("DELETE"),
  path: z.literal("/api/songs/:id/delete"),
  authentication: protectedBrowserRoute
});

export const readingGenerateInputSchema = z.object({
  title: z.string().trim().max(200).default(""),
  artist: z.string().trim().max(200).default("")
}).refine((input) => Boolean(input.title || input.artist), {
  message: "곡명이나 아티스트 중 하나는 필요해."
});

export const readingGenerateResultSchema = z.object({
  titleReadingKo: z.string().trim().max(200),
  artistReadingKo: z.string().trim().max(200)
}).strict();

export const readingGenerateRouteSchema = z.object({
  method: z.literal("POST"),
  path: z.literal("/api/readings/generate"),
  authentication: protectedBrowserRoute
});

export const performanceCreateRequestSchema = z.object({
  songId: z.string().min(1),
  performedAt: z.string().datetime({ offset: true }).optional(),
  keySelection: performanceSchema.shape.keySelection,
  memo: z.string().trim().max(1000).default(""),
  clientRequestId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative().optional()
});

export const performanceCancelRequestSchema = z.object({
  performanceId: z.string().min(1),
  clientRequestId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative().optional()
});

export const songCreateRequestSchema = songSchema.innerType().omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  version: true,
  lastPerformedAt: true,
  performanceCount: true
}).extend({
  clientRequestId: z.string().uuid()
});

export const songUpdateRequestSchema = songCreateRequestSchema.partial().extend({
  id: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  clientRequestId: z.string().uuid()
});

export const songDeleteRequestSchema = z.object({
  songId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  clientRequestId: z.string().uuid()
});

export const tjLookupRouteSchema = z.object({
  method: z.literal("POST"),
  path: z.literal("/api/tj/lookup"),
  authentication: protectedBrowserRoute
});

export const tjSearchRouteSchema = z.object({
  method: z.literal("POST"),
  path: z.literal("/api/tj/search"),
  authentication: protectedBrowserRoute
});

export const tjAddRouteSchema = z.object({
  method: z.literal("POST"),
  path: z.literal("/api/tj/add"),
  authentication: protectedBrowserRoute
});

export const apiRouteContractSchema = z.discriminatedUnion("path", [
  catalogRouteSchema,
  currentUserRouteSchema,
  performanceCreateRouteSchema,
  performanceCancelRouteSchema,
  songCreateRouteSchema,
  songUpdateRouteSchema,
  songDeleteActionRouteSchema,
  readingGenerateRouteSchema,
  tjLookupRouteSchema,
  tjSearchRouteSchema,
  tjAddRouteSchema
]);

export const apiActionContractSchema = z.object({
  performanceCreate: performanceCreateRequestSchema,
  performanceCancel: performanceCancelRequestSchema,
  songCreate: songCreateRequestSchema,
  songUpdate: songUpdateRequestSchema,
  songDelete: songDeleteRequestSchema,
  readingGenerate: readingGenerateInputSchema,
  tjLookup: tjLookupRequestSchema,
  tjSearch: tjSearchRequestSchema,
  tjAdd: z.object({
    candidate: tjSongCandidateSchema,
    clientRequestId: z.string().uuid()
  })
});

export type PerformanceCreateRequest = z.infer<typeof performanceCreateRequestSchema>;
export type PerformanceCancelRequest = z.infer<typeof performanceCancelRequestSchema>;
export type SongCreateRequest = z.infer<typeof songCreateRequestSchema>;
export type SongUpdateRequest = z.infer<typeof songUpdateRequestSchema>;
export type SongDeleteRequest = z.infer<typeof songDeleteRequestSchema>;
export type ReadingGenerateInput = z.infer<typeof readingGenerateInputSchema>;
export type ReadingGenerateResult = z.infer<typeof readingGenerateResultSchema>;

export const idempotencyKeySchema = z.string().uuid();
export const expectedVersionSchema = z.number().int().nonnegative();
export const idempotencyContractSchema = z.object({
  clientRequestId: idempotencyKeySchema,
  expectedVersion: expectedVersionSchema.optional()
});

export const conflictDetailsSchema = z.object({
  reason: z.enum(["idempotency-replay", "version-mismatch"]),
  currentVersion: z.number().int().nonnegative().optional(),
  requestVersion: z.number().int().nonnegative().optional()
});

export const mcpScopeSchema = z.enum(["songbook:read", "songbook:write"]);
export const mcpScopeSetSchema = z.array(mcpScopeSchema).min(1).transform((scopes) => Array.from(new Set(scopes)));
export const mcpAudienceSchema = z.literal("songbook-mcp");

export const mcpProtocolRevisionSchema = z.enum(["2025-06-18", "2026-07-28"]);
export const mcpNegotiationSchema = z.object({
  requestedRevision: mcpProtocolRevisionSchema,
  negotiatedRevision: mcpProtocolRevisionSchema,
  stateless: z.literal(true)
});

export const optionalOAuthMcpMountOptionsSchema = z.object({
  authentication: z.literal("optional-oauth"),
  path: z.literal("/mcp"),
  audience: mcpAudienceSchema,
  stateless: z.literal(true)
});

export interface OptionalOAuthMcpMountOptions {
  authentication: "optional-oauth";
  path: "/mcp";
  audience: "songbook-mcp";
  stateless: true;
}

export type McpScope = z.infer<typeof mcpScopeSchema>;
export type McpNegotiation = z.infer<typeof mcpNegotiationSchema>;
export type McpProtocolRevision = z.infer<typeof mcpProtocolRevisionSchema>;
export type UserRoleContract = z.infer<typeof userRoleSchema>;
export type CatalogResponse = z.infer<typeof catalogResponseSchema>;
export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;
export type TjLookupResponse = z.infer<typeof tjLookupResultSchema>;
export type TjSearchResponse = z.infer<typeof tjSearchResultSchema>;
export type TjAddResponse = z.infer<typeof tjAddResultSchema>;
