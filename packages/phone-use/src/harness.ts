import type { z } from 'zod';

// ---------------------------------------------------------------------------
// The harness seam: the embedded agent loop's model side, behind a small
// interface so the loop is not married to one provider. The registry, driver,
// and permission pipeline stay the single brain; a TurnRunner only decides
// WHICH model reasons over the tools and how the conversation is carried.
//
// Design mirrors the adapter pattern proven by multi-harness orchestrators
// (one turn controller + a declared capability set, differences stated rather
// than papered over). The Anthropic runner (harness-anthropic.ts) is the
// default; alternative runners (an in-process Pi runtime, another provider's
// loop) implement this interface and plug into createSession({ runner }).
//
// A TurnRunner instance is session-scoped: it OWNS the provider-format
// conversation history across runTurn calls (history cannot be neutral — each
// provider's transcript format differs). reset() starts a fresh thread.
// ---------------------------------------------------------------------------

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string };

/** Text remains available for custom runners; providers use rich content when supplied. */
export type TurnTool = {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  run(input: Record<string, unknown>): Promise<string>;
  runRich?(input: Record<string, unknown>): Promise<ToolContent[]>;
};

export type TurnRequest = {
  /** The user's natural-language goal for this turn. */
  goal: string;
  /** System prompt (stable across the session — runners may cache it). */
  system: string;
  /** Provider-namespaced model id. */
  model: string;
  /** Max model iterations before the loop must stop. */
  maxSteps: number;
  /** The tool surface for this turn — permission gating happens inside run(). */
  tools: TurnTool[];
  /** Abort the in-flight/next model call (not a device action mid-execution). */
  signal?: AbortSignal | undefined;
  /** Called with each assistant text block as the loop runs. */
  onAssistantText?: ((text: string) => void) | undefined;
};

export type TurnStatus = 'completed' | 'failed' | 'stopped';

export type TurnOutcome = {
  status: TurnStatus;
  /** Final assistant summary, or a human-readable failure/stop reason. */
  summary: string;
};

export type TurnCapability = 'abort' | 'history' | 'thinking' | 'prompt-caching';

export interface TurnRunner {
  /** Stable runner identifier, e.g. `"anthropic"`. */
  readonly id: string;
  /** What this runner actually supports — declared, never assumed. */
  readonly capabilities: ReadonlySet<TurnCapability>;
  /** Run one goal to completion (model loop + tool execution). Never throws
   *  for provider-legible failures — those come back as status 'failed'. */
  runTurn(req: TurnRequest): Promise<TurnOutcome>;
  /** Drop the conversation history — the next runTurn starts a fresh thread. */
  reset(): void;
}
