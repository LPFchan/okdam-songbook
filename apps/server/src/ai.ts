import { DomainError } from "@songbook/server-core";

export interface AiChatOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Sends one system prompt and one JSON input, and returns the model's parsed JSON answer. */
export type AiJsonChat = (systemPrompt: string, input: unknown) => Promise<unknown>;

function endpoint(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("AI_ENDPOINT must be a valid URL"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("AI_ENDPOINT must use http or https");
  return parsed.toString();
}

function contentFromResponse(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  return (message as { content?: unknown }).content;
}

/**
 * A JSON chat against an OpenAI-compatible endpoint. `label` names the feature
 * in the Korean error messages, e.g. "독음 생성".
 */
export function createAiJsonChat(options: AiChatOptions, label: string): AiJsonChat {
  const url = endpoint(options.endpoint);
  const apiKey = options.apiKey.trim();
  const model = options.model.trim();
  if (!apiKey) throw new Error("CLOUDFLARE_AI_API_TOKEN is required when AI_ENDPOINT is set");
  if (!model) throw new Error("AI_MODEL is required when AI_ENDPOINT is set");
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;

  return async (systemPrompt, input) => {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(input) }
          ]
        }),
        signal: globalThis.AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new DomainError("EXTERNAL_API_ERROR", `${label} 서버에 연결하지 못했어.`);
    }

    if (!response.ok) {
      throw new DomainError("EXTERNAL_API_ERROR", `${label} 서버가 요청을 처리하지 못했어.`, { status: response.status });
    }

    let payload: unknown;
    try { payload = await response.json(); } catch {
      throw new DomainError("EXTERNAL_API_ERROR", `${label} 결과를 읽지 못했어.`);
    }
    const content = contentFromResponse(payload);
    if (typeof content !== "string") throw new DomainError("EXTERNAL_API_ERROR", `${label} 결과 형식이 올바르지 않아.`);
    try { return JSON.parse(content); } catch {
      throw new DomainError("EXTERNAL_API_ERROR", `${label} 결과 형식이 올바르지 않아.`);
    }
  };
}

/**
 * The AI settings from the runtime's environment: the Worker's `env` or
 * Node's `process.env`, the same three names in both. All three or none; a
 * partial set is a misconfiguration, not "off".
 */
export function aiOptionsFromEnvironment(environment: Record<string, string | undefined>): AiChatOptions | undefined {
  const endpoint = environment.AI_ENDPOINT?.trim();
  const apiKey = environment.CLOUDFLARE_AI_API_TOKEN?.trim();
  const model = environment.AI_MODEL?.trim();
  if (!endpoint && !apiKey && !model) return undefined;
  if (!endpoint || !apiKey || !model) throw new Error("AI_ENDPOINT, CLOUDFLARE_AI_API_TOKEN, and AI_MODEL must be set together");
  return { endpoint, apiKey, model };
}
