/**
 * The model adapter. One provider, behind a narrow interface, so the runner and
 * the tools are testable without a network call and without a credential.
 *
 * Two modes, and they are NEVER merged in any report:
 *   - live:   a real API call to a configured model.
 *   - stub:   a deterministic scripted responder for tests and for an outage.
 *
 * A stub run is not evidence that an AI agent works. The evaluation reports the
 * two populations separately, with separate denominators.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ModelTurn {
  readonly text: string | null;
  readonly toolCalls: readonly ModelToolCall[];
  readonly stopReason: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ConversationMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

export type AgentMode = 'live' | 'stub' | 'guided';

export interface ModelAdapter {
  readonly mode: AgentMode;
  readonly modelName: string;
  complete(input: {
    system: string;
    messages: readonly ConversationMessage[];
    tools: readonly ToolSpec[];
    signal?: AbortSignal;
  }): Promise<ModelTurn>;
}

export class ModelUnavailableError extends Error {
  constructor(
    readonly reason: 'NO_CREDENTIAL' | 'HTTP_ERROR' | 'TIMEOUT' | 'MALFORMED',
    /** Status and provider message, so a bad key, a blocked network and a wrong
     *  model id are distinguishable instead of all reading "unavailable". */
    readonly detail?: string,
  ) {
    super(detail ? `model unavailable: ${reason} (${detail})` : `model unavailable: ${reason}`);
    this.name = 'ModelUnavailableError';
  }
}

/** Provider error text, truncated and stripped of anything key-shaped. */
export async function describeHttpFailure(res: Response): Promise<string> {
  let body = '';
  try {
    body = (await res.text()).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 200);
  } catch {
    /* body already consumed or unreadable */
  }
  return `HTTP ${res.status}${body ? ' ' + body : ''}`;
}

/**
 * Live adapter for the Anthropic Messages API.
 *
 * The exact model id comes from MODEL_NAME. It is never hard-coded and never
 * guessed: an invented model id is a fabricated capability claim.
 */
export function liveAdapter(): ModelAdapter {
  const apiKey = process.env.MODEL_API_KEY;
  const modelName = process.env.MODEL_NAME;
  if (!apiKey || !modelName) throw new ModelUnavailableError('NO_CREDENTIAL');

  return {
    mode: 'live',
    modelName,
    async complete({ system, messages, tools, signal }) {
      const body = {
        model: modelName,
        max_tokens: Number(process.env.MAX_RUN_TOKENS ?? 2048),
        system,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        messages: toProviderMessages(messages),
      };

      let res: Response;
      try {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (fetchError) {
        throw new ModelUnavailableError('TIMEOUT', fetchError instanceof Error ? fetchError.message.slice(0, 120) : undefined);
      }
      if (!res.ok) throw new ModelUnavailableError('HTTP_ERROR', await describeHttpFailure(res));

      const payload = (await res.json()) as {
        content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const parts = payload.content ?? [];
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n') || null;
      const toolCalls = parts
        .filter((p) => p.type === 'tool_use')
        .map((p) => ({ id: p.id ?? '', name: p.name ?? '', args: p.input }));

      return {
        text,
        toolCalls,
        stopReason: payload.stop_reason ?? 'end_turn',
        // Reported only when the API actually returns it. Never invented.
        inputTokens: payload.usage?.input_tokens,
        outputTokens: payload.usage?.output_tokens,
      };
    },
  };
}

function toProviderMessages(messages: readonly ConversationMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const content: unknown[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      out.push({ role: 'assistant', content });
    } else {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      });
    }
  }
  return out;
}

/**
 * Live adapter for an OpenAI-compatible Chat Completions endpoint.
 *
 * Selected when MODEL_BASE_URL is set (e.g. https://api.openai.com/v1 or a
 * compatible gateway). The model id comes from MODEL_NAME and is never guessed.
 */
export function openaiCompatibleAdapter(): ModelAdapter {
  const apiKey = process.env.MODEL_API_KEY;
  const modelName = process.env.MODEL_NAME;
  const baseUrl = process.env.MODEL_BASE_URL;
  if (!apiKey || !modelName || !baseUrl) throw new ModelUnavailableError('NO_CREDENTIAL');
  const endpoint = baseUrl.replace(/\/$/, '') + '/chat/completions';

  return {
    mode: 'live',
    modelName,
    async complete({ system, messages, tools, signal }) {
      const body = {
        model: modelName,
        max_tokens: Number(process.env.MAX_RUN_TOKENS ?? 2048),
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
        messages: [{ role: 'system', content: system }, ...toOpenAiMessages(messages)],
      };

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (fetchError) {
        throw new ModelUnavailableError('TIMEOUT', fetchError instanceof Error ? fetchError.message.slice(0, 120) : undefined);
      }
      if (!res.ok) throw new ModelUnavailableError('HTTP_ERROR', await describeHttpFailure(res));

      const payload = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msg = payload.choices?.[0]?.message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((c) => {
        let args: unknown = {};
        try {
          args = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          args = {};
        }
        return { id: c.id ?? '', name: c.function?.name ?? '', args };
      });

      return {
        text: msg.content ?? null,
        toolCalls,
        stopReason: payload.choices?.[0]?.finish_reason ?? 'stop',
        inputTokens: payload.usage?.prompt_tokens,
        outputTokens: payload.usage?.completion_tokens,
      };
    },
  };
}

function toOpenAiMessages(messages: readonly ConversationMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user' && !m.toolCallId) {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: (m.toolCalls ?? []).map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

/** True when a live run is actually possible. Used to report P4 honestly. */
export function liveModelConfigured(): boolean {
  return Boolean(process.env.MODEL_API_KEY && process.env.MODEL_NAME);
}

/** Picks the configured live adapter: OpenAI-compatible when MODEL_BASE_URL is set, else Anthropic. */
export function selectLiveAdapter(): ModelAdapter {
  return process.env.MODEL_BASE_URL ? openaiCompatibleAdapter() : liveAdapter();
}

/**
 * A scripted responder. It exists so the deterministic system stays usable when
 * the model is down, and so the tool boundary can be tested without a credential.
 *
 * It is labelled stub everywhere it appears, including in the UI and in evidence.
 */
export function stubAdapter(script: readonly ModelTurn[]): ModelAdapter {
  let index = 0;
  return {
    mode: 'stub',
    modelName: 'scripted-stub',
    async complete() {
      const turn = script[index] ?? {
        text: 'The scripted demonstration has no further steps.',
        toolCalls: [],
        stopReason: 'end_turn',
      };
      index += 1;
      return turn;
    },
  };
}
