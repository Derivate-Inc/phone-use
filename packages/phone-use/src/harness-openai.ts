import OpenAI from 'openai';
import { z } from 'zod';
import type { TurnOutcome, TurnRequest, TurnRunner, TurnTool } from './harness.ts';

// ---------------------------------------------------------------------------
// An OpenAI-compatible TurnRunner: one adapter, most of the provider
// ecosystem. Everything that speaks the OpenAI chat-completions wire format
// (OpenRouter, Groq, Together, Fireworks, DeepSeek, xAI, and local Ollama /
// LM Studio) is reachable by pointing `baseURL` at it — no per-provider code.
//
// Unlike the Anthropic SDK there is no built-in agentic runner here, so the
// tool loop is explicit: call → run any tool_calls → append results → repeat
// until the model answers without tool calls or maxSteps is hit. That loop is
// the whole adapter; the registry, permission gate, and step logging live
// where they always did (tools.ts), untouched.
// ---------------------------------------------------------------------------

export type OpenAIRunnerOptions = {
  /** API key (default: OPENAI_API_KEY from the environment). */
  apiKey?: string | undefined;
  /** Endpoint override — the lever that reaches every compatible provider.
   *  Default: PHONE_USE_BASE_URL, else OpenAI's own API. */
  baseURL?: string | undefined;
  /** Extra headers some gateways require (e.g. OpenRouter attribution). */
  headers?: Record<string, string> | undefined;
};

/** Our neutral TurnTool → the OpenAI function-tool wire format. */
function toOpenAITools(tools: TurnTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      // zod v4 emits draft-2020-12 JSON Schema, which the API accepts as-is.
      parameters: z.toJSONSchema(t.inputSchema) as Record<string, unknown>,
    },
  }));
}

export function createOpenAIRunner(opts: OpenAIRunnerOptions = {}): TurnRunner {
  // Lazy client so runner construction never needs a credential.
  let client: OpenAI | null = null;
  let history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  return {
    id: 'openai',
    // No 'thinking': reasoning models expose it per-provider, not uniformly.
    // No 'prompt-caching': compatible endpoints cache implicitly at best.
    capabilities: new Set(['abort', 'history']),
    reset() {
      history = [];
    },
    async runTurn(req: TurnRequest): Promise<TurnOutcome> {
      try {
        client ??= new OpenAI({
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
          ...((opts.baseURL ?? process.env.PHONE_USE_BASE_URL)
            ? { baseURL: opts.baseURL ?? process.env.PHONE_USE_BASE_URL }
            : {}),
          ...(opts.headers ? { defaultHeaders: opts.headers } : {}),
        });

        const byName = new Map(req.tools.map((t) => [t.name, t]));
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
          { role: 'system', content: req.system },
          ...history,
          { role: 'user', content: req.goal },
        ];

        for (let step = 0; step < req.maxSteps; step++) {
          req.signal?.throwIfAborted();
          const completion = await client.chat.completions.create(
            {
              model: req.model,
              messages,
              tools: toOpenAITools(req.tools),
              max_completion_tokens: 16000,
            },
            { ...(req.signal ? { signal: req.signal } : {}) },
          );

          const choice = completion.choices[0];
          if (!choice) return { status: 'failed', summary: 'Provider returned no choices.' };
          if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls')
            return { status: 'failed', summary: `Provider stopped with ${choice.finish_reason}.` };
          const message = choice.message;
          messages.push(message);

          const text = message.content?.trim();
          if (text) req.onAssistantText?.(text);

          const calls = message.tool_calls ?? [];
          if (calls.length === 0) {
            // No tool calls: the model is answering, so the turn is done.
            history = messages.slice(1); // drop the system message; it is re-added per turn
            return text
              ? { status: 'completed', summary: text }
              : { status: 'failed', summary: 'Agent stopped without a final summary.' };
          }

          const images: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
          for (const call of calls) {
            req.signal?.throwIfAborted();
            if (call.type !== 'function') continue;
            const tool = byName.get(call.function.name);
            // Tool errors are the model's problem to recover from, not the
            // loop's: feed the failure back as the result and let it re-plan.
            let result: string;
            if (!tool) {
              result = `ERROR: unknown tool ${call.function.name}`;
            } else {
              try {
                const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
                const input = tool.inputSchema.parse(args);
                if (tool.runRich) {
                  const content = await tool.runRich(input);
                  result = content
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('\n');
                  for (const block of content) {
                    if (block.type === 'image') {
                      images.push({
                        type: 'text',
                        text: `Image from tool ${call.function.name} (${call.id})`,
                      });
                      images.push({
                        type: 'image_url',
                        image_url: { url: `data:${block.mimeType};base64,${block.data}` },
                      });
                    }
                  }
                } else {
                  result = await tool.run(input);
                }
              } catch (error) {
                result = `ERROR: ${String(error)}`;
              }
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: result });
          }
          if (images.length) messages.push({ role: 'user', content: images });
        }

        history = messages.slice(1);
        return {
          status: 'failed',
          summary: `Agent stopped without a final summary (step limit ${req.maxSteps} reached).`,
        };
      } catch (error) {
        if (req.signal?.aborted || error instanceof OpenAI.APIUserAbortError) {
          return { status: 'stopped', summary: 'Stopped by caller.' };
        }
        const message = error instanceof OpenAI.APIError ? `${error.status} ${error.message}` : String(error);
        return { status: 'failed', summary: `Agent error: ${message}` };
      }
    },
  };
}
