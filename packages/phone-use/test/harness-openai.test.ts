import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultRunner } from '../src/agent.ts';
import type { TurnTool } from '../src/harness.ts';
import { createOpenAIRunner } from '../src/harness-openai.ts';

// A mock OpenAI-compatible server: proves the adapter over the REAL wire
// format (tool schemas out, tool_calls in, tool results echoed back) without
// a network call or a credential. Any compatible provider — OpenRouter, Groq,
// Ollama — differs only in baseURL, which is exactly what this exercises.

type Recorded = { model: string; messages: unknown[]; tools: { function: { name: string } }[] };

let server: Server;
let baseURL: string;
const seen: Recorded[] = [];
// Queue of canned assistant messages, consumed one per request.
let script: Record<string, unknown>[] = [];

// node:http, not Bun.serve — the vitest tier runs under Node so it stays
// portable (and CI-runnable) without a Bun runtime.
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Recorded;
      seen.push(body);
      const message = script.shift() ?? { role: 'assistant', content: 'done' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: body.model,
          choices: [{ index: 0, message, finish_reason: 'stop' }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseURL = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const echoTool = (calls: unknown[]): TurnTool => ({
  name: 'note',
  description: 'save a note',
  inputSchema: z.object({ key: z.string().describe('note name'), content: z.string().optional() }),
  run: async (input) => {
    calls.push(input);
    return `saved ${String(input.key)}`;
  },
});

const request = (tools: TurnTool[]) => ({
  goal: 'save a note called seam',
  system: 'You are Phone Use.',
  model: 'gpt-test',
  maxSteps: 5,
  tools,
});

describe('createOpenAIRunner', () => {
  it('runs a tool call and returns the final answer', async () => {
    const calls: unknown[] = [];
    script = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'note', arguments: JSON.stringify({ key: 'seam', content: 'hi' }) },
          },
        ],
      },
      { role: 'assistant', content: 'Saved the note.' },
    ];
    const texts: string[] = [];
    const runner = createOpenAIRunner({ apiKey: 'test-key', baseURL });
    const outcome = await runner.runTurn({
      ...request([echoTool(calls)]),
      onAssistantText: (t) => texts.push(t),
    });

    expect(outcome).toEqual({ status: 'completed', summary: 'Saved the note.' });
    expect(calls).toEqual([{ key: 'seam', content: 'hi' }]);
    expect(texts).toEqual(['Saved the note.']);

    // Wire format: zod schema became a JSON Schema function tool, and the tool
    // result was fed back on the second request.
    const first = seen.at(-2);
    expect(first?.tools[0]?.function).toMatchObject({
      name: 'note',
      parameters: { type: 'object', properties: { key: { type: 'string', description: 'note name' } } },
    });
    const second = seen.at(-1)?.messages ?? [];
    expect(second).toContainEqual({ role: 'tool', tool_call_id: 'call_1', content: 'saved seam' });
  });

  it('delivers images after all tool results, with source attribution', async () => {
    script = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'image-call', type: 'function', function: { name: 'screen', arguments: '{}' } },
          { id: 'note-call', type: 'function', function: { name: 'note', arguments: '{"key":"x"}' } },
        ],
      },
      { role: 'assistant', content: 'I can see it.' },
    ];
    const screen: TurnTool = {
      name: 'screen',
      description: 'capture',
      inputSchema: z.object({}),
      run: async () => '/tmp/screen.png',
      runRich: async () => [
        { type: 'text', text: 'screen' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
      ],
    };
    await createOpenAIRunner({ apiKey: 'test-key', baseURL }).runTurn(request([screen, echoTool([])]));
    const messages = seen.at(-1)?.messages as { role: string; content: unknown }[];
    expect(messages.slice(-3).map((m) => m.role)).toEqual(['tool', 'tool', 'user']);
    expect(messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'Image from tool screen (image-call)' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
    ]);
  });

  it('a tool that throws is reported to the model, not the caller', async () => {
    script = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'boom', arguments: '{}' } }],
      },
      { role: 'assistant', content: 'recovered' },
    ];
    const boom: TurnTool = {
      name: 'boom',
      description: 'always throws',
      inputSchema: z.object({}),
      run: async () => {
        throw new Error('handler exploded');
      },
    };
    const runner = createOpenAIRunner({ apiKey: 'test-key', baseURL });
    const outcome = await runner.runTurn(request([boom]));
    expect(outcome.status).toBe('completed');
    const toolMsg = (seen.at(-1)?.messages ?? []).find((m) => (m as { role: string }).role === 'tool') as {
      content: string;
    };
    expect(toolMsg.content).toContain('handler exploded');
  });

  it('stops at maxSteps when the model never settles', async () => {
    const loop = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'note', arguments: '{"key":"x"}' } }],
    };
    script = [loop, loop, loop, loop, loop];
    const runner = createOpenAIRunner({ apiKey: 'test-key', baseURL });
    const outcome = await runner.runTurn({ ...request([echoTool([])]), maxSteps: 3 });
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('step limit 3');
  });

  it('history carries across turns and reset() clears it', async () => {
    const runner = createOpenAIRunner({ apiKey: 'test-key', baseURL });
    script = [{ role: 'assistant', content: 'one' }];
    await runner.runTurn(request([echoTool([])]));
    script = [{ role: 'assistant', content: 'two' }];
    await runner.runTurn(request([echoTool([])]));
    // Second turn carries turn one's exchange plus the new goal.
    expect((seen.at(-1)?.messages ?? []).length).toBeGreaterThan(3);

    runner.reset();
    script = [{ role: 'assistant', content: 'three' }];
    await runner.runTurn(request([echoTool([])]));
    expect(seen.at(-1)?.messages).toHaveLength(2); // system + user only
  });
});

describe('defaultRunner selection', () => {
  it('defaults to anthropic, and switches on provider/base-url/model', () => {
    expect(defaultRunner({}).id).toBe('anthropic');
    expect(defaultRunner({ PHONE_USE_MODEL: 'claude-opus-4-8' }).id).toBe('anthropic');
    expect(defaultRunner({ PHONE_USE_PROVIDER: 'openai' }).id).toBe('openai');
    expect(defaultRunner({ PHONE_USE_BASE_URL: 'http://localhost:11434/v1' }).id).toBe('openai');
    expect(defaultRunner({ PHONE_USE_MODEL: 'gpt-5' }).id).toBe('openai');
    // Explicit provider wins over an inferring model id.
    expect(defaultRunner({ PHONE_USE_PROVIDER: 'anthropic', PHONE_USE_MODEL: 'gpt-5' }).id).toBe('anthropic');
  });
});
