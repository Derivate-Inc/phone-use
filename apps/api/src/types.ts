import type { Capability, DevicePlatform } from '@phone-use/sdk';

export type SandboxStatus = 'queued' | 'preparing' | 'running' | 'draining' | 'closed' | 'failed';

export type SandboxConnection = {
  endpoint: string;
  token: string;
  deviceId: string;
  capabilities: Capability[];
};

export type Sandbox = {
  id: string;
  platform: DevicePlatform;
  status: SandboxStatus;
  name?: string | undefined;
  hostId?: string | undefined;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastActiveAt: string;
  idleTimeoutMs: number | false;
  error?: string | undefined;
  connection?: SandboxConnection | undefined;
};

export type CreateSandboxOptions = {
  platform: DevicePlatform;
  ttlMs?: number | undefined;
  idleTimeoutMs?: number | false | undefined;
  wait?: boolean | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

export type CloudClientOptions = {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
};

export type WorkerHost = {
  id: string;
  platform: DevicePlatform;
  capacity: number;
  publicUrl: string;
  metadata?: Record<string, unknown> | undefined;
};

export type ProvisionedResource = {
  deviceId: string;
  name?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type WorkerJob =
  | {
      kind: 'create';
      sandbox: Sandbox;
      connectionToken: string;
    }
  | {
      kind: 'delete';
      sandbox: Sandbox;
    };

export type RpcMethod =
  | 'viewerInput'
  | 'snapshot'
  | 'screenshot'
  | 'press'
  | 'longPress'
  | 'fill'
  | 'typeText'
  | 'pressKey'
  | 'scroll'
  | 'pan'
  | 'installApp'
  | 'waitForText'
  | 'systemAlert'
  | 'home'
  | 'back'
  | 'openApp'
  | 'listApps'
  | 'closeSession'
  | 'checkpoint'
  | 'restoreCheckpoint'
  | 'listCheckpoints'
  | 'deleteCheckpoint';

/**
 * A saved device state for one sandbox. The device behind `checkpointUdid` is a
 * shutdown simulator clone that is never booted — restore clones IT, so one
 * checkpoint can be restored any number of times.
 */
export type SandboxCheckpoint = {
  id: string;
  checkpointUdid: string;
  label?: string | undefined;
  createdAt: string;
};

export type RpcRequest = { method: RpcMethod; args: unknown[] };
export type RpcSuccess = { ok: true; result: unknown };
export type RpcFailure = {
  ok: false;
  error: { message: string; code?: string | undefined; retryable?: boolean | undefined };
};
export type RpcResponse = RpcSuccess | RpcFailure;
