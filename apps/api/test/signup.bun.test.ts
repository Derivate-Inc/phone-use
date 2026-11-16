import { describe, expect, test } from 'bun:test';
import { createControlPlane } from '../src/control-plane.ts';
import { CloudStore } from '../src/store.ts';

const plane = (allowedOrigins: string[] = []) =>
  createControlPlane({
    apiToken: 'admin',
    workerToken: 'worker',
    store: new CloudStore(':memory:'),
    allowedOrigins,
  });

describe('retired signup + CORS allowlist', () => {
  test('the name-only /v1/signup is a documented 410, not a silent 404', async () => {
    const p = plane();
    const gone = await p.fetch(
      new Request('http://cp/v1/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'anyone' }),
      }),
    );
    expect(gone.status).toBe(410);
    expect(((await gone.json()) as { error: string }).error).toContain('console');
    p.close();
  });

  test('CORS grants exist only for allowed origins; others get none', async () => {
    const p = plane(['https://app.phoneuse.dev']);
    const allowed = await p.fetch(
      new Request('http://cp/healthz', { headers: { origin: 'https://app.phoneuse.dev' } }),
    );
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.phoneuse.dev');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

    const stranger = await p.fetch(
      new Request('http://cp/healthz', { headers: { origin: 'https://evil.example' } }),
    );
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
    p.close();
  });

  test('every /v1 response carries a request id', async () => {
    const p = plane();
    const res = await p.fetch(
      new Request('http://cp/v1/sandboxes', { headers: { authorization: 'Bearer admin' } }),
    );
    expect(res.headers.get('x-request-id')).toMatch(/^[a-f0-9]{8}$/);
    p.close();
  });
});
