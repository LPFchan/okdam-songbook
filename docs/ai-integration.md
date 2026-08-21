# AI Integration

AI helpers are server-mediated.

## Live reading adapter

The OCI server calls an OpenAI-compatible chat-completions endpoint. Set the
full endpoint URL, model name, and bearer credential with `AI_ENDPOINT`,
`AI_MODEL`, and `AI_API_KEY`. All three values must be present together. If
none are set, the application still starts and the reading route returns
`AI_NOT_CONFIGURED` so manual entry remains available.

The provider must support `response_format: { "type": "json_object" }` and
return `titleReadingKo` and `artistReadingKo` as strings in the assistant
message content. Provider calls time out after 20 seconds. Provider response
bodies and credentials are never returned to the browser.

Local browser mock mode returns deterministic placeholders without calling a
provider.

## Supported tasks

- Korean reading generation.
- YouTube metadata candidate extraction.
- Image/song extraction contract for future UI wiring.

AI results are never auto-saved. The user reviews and edits candidate fields first.
