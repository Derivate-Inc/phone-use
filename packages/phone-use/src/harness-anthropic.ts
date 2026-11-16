import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { TurnOutcome, TurnRequest, TurnRunner } from './harness.ts';

// ---------------------------------------------------------------------------
// The default TurnRunner: Anthropic's toolRunner agentic loop. This file is
// the ONLY place the phone-use loop touches @anthropic-ai/sdk — the neutral
// TurnTool definitions are converted to betaZodTool here, at the boundary.
//
// Caching: the stable system+tools prefix carries a cache breakpoint so every
// iteration after the first pays cache-read instead of re-billing the whole
// tool schema + system prompt. LLM round-trips dominate task latency; this is
// the cheapest lever against the dominant term.
// ---------------------------------------------------------------------------

const joinText = (content: Anthropic.Beta.Messages.BetaMessage['content']): string =>
  content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

export function createAnthropicRunner(
  opts: { apiKey?: string | undefined; baseURL?: string | undefined } = {},
): TurnRunner {
  // Lazy client: `new Anthropic()` throws when no credential resolves, so
  // defer construction until the first turn — runner creation stays key-free.
  let client: Anthropic | null = null;
  // Provider-format history, owned here: the toolRunner clones its seed
  // messages and appends every assistant + tool result, so params.messages is
  // the full replayable thread for the next runTurn.
  let history: Anthropic.Beta.Messages.BetaMessageParam[] = [];

  return {
    id: 'anthropic',
    capabilities: new Set(['abort', 'history', 'thinking', 'prompt-caching']),
    reset() {
      history = [];
    },
    async runTurn(req: TurnRequest): Promise<TurnOutcome> {
      try {
        client ??= new Anthropic({
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
          ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
        });
        const runner = client.beta.messages.toolRunner({
          model: req.model,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          tools: req.tools.map((t) =>
            betaZodTool({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              run: async (args) =>
                t.runRich
                  ? (await t.runRich(args)).map((block) =>
                      block.type === 'text'
                        ? block
                        : {
                            type: 'image' as const,
                            source: { type: 'base64' as const, media_type: block.mimeType, data: block.data },
                          },
                    )
                  : t.run(args),
            }),
          ),
          max_iterations: req.maxSteps,
          messages: [...history, { role: 'user', content: req.goal }],
        });
        if (req.signal) runner.setRequestOptions({ signal: req.signal });

        // Step-granular streaming: each iteration yields a complete assistant
        // BetaMessage. Emit its text blocks; thinking blocks carry no text.
        for await (const message of runner) {
          const text = joinText(message.content);
          if (text) req.onAssistantText?.(text);
        }

        const final = await runner.done();
        history = [...runner.params.messages];

        const summary = joinText(final.content);
        return summary && final.stop_reason === 'end_turn'
          ? { status: 'completed', summary }
          : {
              status: 'failed',
              summary: 'Agent stopped without a final summary (step limit may have been reached).',
            };
      } catch (error) {
        if (error instanceof Anthropic.APIUserAbortError) {
          return { status: 'stopped', summary: 'Stopped by caller.' };
        }
        const message =
          error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : String(error);
        return { status: 'failed', summary: `Agent error: ${message}` };
      }
    },
  };
}
