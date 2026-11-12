// Calls the Anthropic Messages API directly with fetch, so there is no SDK
// version to keep in sync. The response is constrained to a JSON schema
// (structured outputs), so parsing never depends on the model's phrasing.
// Docs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
}

interface MessagesResponse {
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

/**
 * Re-running a check should give the same answer, so sampling is pinned to
 * temperature 0 and the default model is a dated snapshot, not an alias.
 * Models from the 5 family reject sampling parameters (a 400), so they are
 * sent only to the 4.x and older models that take them.
 */
export function acceptsTemperature(model: string): boolean {
  return /^claude-(?:3|(?:haiku|sonnet|opus)-4)\b/.test(model);
}

export const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

/** One request, one JSON object back that matches `schema`. Throws on any failure. */
export async function callStructured(
  options: AnthropicOptions,
  request: {
    system: string;
    /** Plain text, or content blocks (text and images) for a vision request. */
    user: string | Array<Record<string, unknown>>;
    schema: Record<string, unknown>;
    maxTokens: number;
    what: string;
  },
): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': options.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: options.model || DEFAULT_MODEL,
      max_tokens: request.maxTokens,
      ...(acceptsTemperature(options.model || DEFAULT_MODEL) ? { temperature: 0 } : {}),
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      output_config: { format: { type: 'json_schema', schema: request.schema } },
    }),
  });

  const data = (await res.json()) as MessagesResponse;
  if (!res.ok) {
    throw new Error(`${request.what} failed (${res.status}): ${data.error?.message ?? 'unknown error'}`);
  }
  // A refusal or a cut-off response may not match the schema.
  if (data.stop_reason === 'refusal' || data.stop_reason === 'max_tokens') {
    throw new Error(`${request.what} stopped early (${data.stop_reason}).`);
  }

  const text = data.content?.find((block) => block.type === 'text')?.text;
  if (!text) throw new Error(`${request.what} returned no text.`);
  return JSON.parse(text) as unknown;
}
