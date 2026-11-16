import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createAnthropicRunner } from '../src/harness-anthropic.ts';

it('sends rich tool results through the real Anthropic SDK wire format', async () => {
  const requests: { messages: unknown[] }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const first = requests.length === 1;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'test',
          content: first
            ? [{ type: 'tool_use', id: 'screen-call', name: 'screen', input: {} }]
            : [{ type: 'text', text: 'Visible.' }],
          stop_reason: first ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const result = await createAnthropicRunner({
      apiKey: 'test',
      baseURL: `http://127.0.0.1:${address.port}`,
    }).runTurn({
      model: 'test',
      goal: 'look',
      system: 'test',
      maxSteps: 3,
      tools: [
        {
          name: 'screen',
          description: 'look',
          inputSchema: z.object({}),
          run: async () => 'path',
          runRich: async () => [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }],
        },
      ],
    });
    expect(result.status).toBe('completed');
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      '"source":{"type":"base64","media_type":"image/png","data":"aW1hZ2U="}',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
