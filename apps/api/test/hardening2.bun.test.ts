import { describe, expect, test } from 'bun:test';
import { createControlPlane } from '../src/control-plane.ts';
import { CloudStore } from '../src/store.ts';
import { classifyRpcError, isRetryableRpcError } from '../src/worker.ts';

describe('rpc error taxonomy', () => {
  test('untyped driver errors classify into stable buckets', () => {
    expect(classifyRpcError('Invalid device: UDID-X')).toBe('device_gone');
    expect(classifyRpcError('operation timed out after 30s')).toBe('timeout');
    expect(classifyRpcError('Session default is already bound')).toBe('session_conflict');
    expect(classifyRpcError('element not found: Done')).toBe('target_not_found');
    expect(classifyRpcError('something exploded')).toBe('internal');
  });

  test('only transient buckets are retryable', () => {
    expect(isRetryableRpcError('operation timed out')).toBe(true);
    expect(isRetryableRpcError('Session default is already bound')).toBe(true);
    expect(isRetryableRpcError('Invalid device: UDID-X')).toBe(false);
    expect(isRetryableRpcError('something exploded')).toBe(false);
  });
});

describe('per-route rate limits', () => {
  test('key rotation caps at 10/minute per tenant', async () => {
    const store = new CloudStore(':memory:');
    const plane = createControlPlane({ apiToken: 'admin', workerToken: 'worker', store });
    const tenant = store.createTenant('spinner');
    let key = tenant.key;
    for (let i = 0; i < 10; i++) {
      const res = await plane.fetch(
        new Request('http://cp/v1/keys/rotate', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}` },
        }),
      );
      expect(res.status).toBe(201);
      key = ((await res.json()) as { key: string }).key;
    }
    const eleventh = await plane.fetch(
      new Request('http://cp/v1/keys/rotate', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    expect(eleventh.status).toBe(429);
    plane.close();
  });
});
