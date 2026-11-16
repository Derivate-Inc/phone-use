import { describe, expect, it } from 'vitest';
import { submitWaitlist } from '../app/waitlist/submit';

type Sent = { url: string; init: RequestInit | undefined };

function stub(respond: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
  return { sent, fetchImpl };
}

describe('waitlist form submission', () => {
  it('posts the email and the answer to the control plane through this origin', async () => {
    const { sent, fetchImpl } = stub(() => Response.json({ ok: true }, { status: 201 }));
    const result = await submitWaitlist({ email: '  dev@example.com ', useCase: ' UI tests on every PR ' }, fetchImpl);
    expect(result).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/v1/waitlist');
    expect(sent[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({
      email: 'dev@example.com',
      useCase: 'UI tests on every PR',
    });
  });

  it('does not send a malformed email at all', async () => {
    const { sent, fetchImpl } = stub(() => Response.json({ ok: true }, { status: 201 }));
    for (const email of ['', 'nope', 'a@b', 'two words@example.com']) {
      expect(await submitWaitlist({ email, useCase: '' }, fetchImpl)).toEqual({
        ok: false,
        message: 'Enter a valid email address.',
      });
    }
    expect(sent).toEqual([]);
  });

  it('requires an explicit save acknowledgement before confirming', async () => {
    for (const response of [
      new Response('<html>wrong upstream</html>', { status: 200 }),
      new Response(null, { status: 204 }),
      Response.json(null),
      Response.json({ ok: false }),
      Response.json({}),
    ]) {
      const { fetchImpl } = stub(() => response);
      expect(await submitWaitlist({ email: 'dev@example.com', useCase: '' }, fetchImpl)).toEqual({
        ok: false,
        message: 'Something went wrong on our side. Try again in a minute.',
      });
    }
  });

  it('handles a null error response without leaving the form stuck sending', async () => {
    const { fetchImpl } = stub(() => Response.json(null, { status: 400 }));
    expect(await submitWaitlist({ email: 'dev@example.com', useCase: '' }, fetchImpl)).toEqual({
      ok: false,
      message: 'Something went wrong on our side. Try again in a minute.',
    });
  });

  it('shows the server’s own message for a rejected entry', async () => {
    const { fetchImpl } = stub(() => Response.json({ error: 'Enter a valid email address.' }, { status: 400 }));
    expect(await submitWaitlist({ email: 'dev@example.com', useCase: '' }, fetchImpl)).toEqual({
      ok: false,
      message: 'Enter a valid email address.',
    });
  });

  it('explains a rate limit, a server fault and a dropped connection without confirming', async () => {
    const limited = stub(() => Response.json({ error: 'x' }, { status: 429 }));
    expect(await submitWaitlist({ email: 'dev@example.com', useCase: '' }, limited.fetchImpl)).toEqual({
      ok: false,
      message: 'Too many requests from here. Try again in a minute.',
    });
    const broken = stub(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await submitWaitlist({ email: 'dev@example.com', useCase: '' }, broken.fetchImpl)).toEqual({
      ok: false,
      message: 'Something went wrong on our side. Try again in a minute.',
    });
    const offline = stub(() => {
      throw new TypeError('fetch failed');
    });
    expect(await submitWaitlist({ email: 'dev@example.com', useCase: '' }, offline.fetchImpl)).toEqual({
      ok: false,
      message: 'Could not reach the server. Check your connection and try again.',
    });
  });
});
