#!/usr/bin/env bun
// The stranger test: the first five minutes of a brand-new user, end to end,
// against the LIVE product — a throwaway inbox, email/password signup, the
// verification link, a minted API key, a cloud phone, one observation, one
// screenshot, close. Prints timings and a PASS/FAIL verdict; exit 1 on FAIL.
//
//   bun scripts/stranger-test.ts                  # against https://api.phoneuse.dev
//   PHONE_USE_CLOUD_URL=http://localhost:8080 bun scripts/stranger-test.ts
//   STRANGER_PLATFORM=android bun scripts/stranger-test.ts
//
// Run it from a machine that can reach the API (a laptop, not CI). The inbox
// comes from mail.tm's public API, so it needs nothing configured; the account
// it creates is real — the control plane mails the operator on every signup,
// so expect one "new signup: …@…" mail per run.
import { createCloudSandboxBackend } from '@phone-use/sdk';

const API = (process.env.PHONE_USE_CLOUD_URL ?? 'https://api.phoneuse.dev').replace(/\/+$/, '');
const ORIGIN = process.env.STRANGER_ORIGIN ?? 'https://app.phoneuse.dev';
const PLATFORM = (process.env.STRANGER_PLATFORM ?? 'ios') as 'ios' | 'android';
const MAIL = 'https://api.mail.tm';

const t0 = performance.now();
const since = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
const log = (line: string) => console.log(`  [${since().padStart(6)}] ${line}`);
const fail = (why: string): never => {
  console.error(`\nSTRANGER TEST FAILED — ${why}`);
  process.exit(1);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- a throwaway inbox ------------------------------------------------------

async function mailTm<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${MAIL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) fail(`mail.tm ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function makeInbox(): Promise<{ address: string; token: string }> {
  const domains = await mailTm<{ 'hydra:member': Array<{ domain: string }> }>('/domains');
  const domain = domains['hydra:member'][0]?.domain ?? fail('mail.tm offered no domains');
  const address = `pu-stranger-${Date.now().toString(36)}@${domain}`;
  const password = crypto.randomUUID();
  await mailTm('/accounts', { method: 'POST', body: JSON.stringify({ address, password }) });
  const { token } = await mailTm<{ token: string }>('/token', {
    method: 'POST',
    body: JSON.stringify({ address, password }),
  });
  return { address, token };
}

async function waitForVerificationLink(token: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await mailTm<{ 'hydra:member': Array<{ id: string; subject: string }> }>('/messages', {}, token);
    const hit = list['hydra:member'].find((m) => /verify/i.test(m.subject));
    if (hit) {
      const msg = await mailTm<{ html?: string[]; text?: string }>(`/messages/${hit.id}`, {}, token);
      const body = `${(msg.html ?? []).join('\n')}\n${msg.text ?? ''}`;
      const link = body.match(/https?:\/\/[^\s"'<>]+verify-email[^\s"'<>]*/)?.[0];
      if (link) return link.replaceAll('&amp;', '&');
      fail('verification mail arrived but contained no verify-email link');
    }
    await sleep(3_000);
  }
  return fail(
    `no verification email within ${timeoutMs / 1000}s — is RESEND_API_KEY set on the control plane, and is Resend under its daily cap?`,
  );
}

// ---- the control plane, as a browser would see it ---------------------------

const jar = new Map<string, string>();
function absorbCookies(res: Response): void {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (pair && eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function browser(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    redirect: 'manual',
    ...init,
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(init.headers ?? {}),
    },
  });
  absorbCookies(res);
  return res;
}

// ---- the run ------------------------------------------------------------------

console.log(`\nStranger test against ${API} (${PLATFORM})\n`);

const inbox = await makeInbox();
log(`inbox ${inbox.address}`);

const password = `Pu-${crypto.randomUUID()}`;
const signup = await browser('/api/auth/sign-up/email', {
  method: 'POST',
  body: JSON.stringify({ name: 'Stranger', email: inbox.address, password }),
});
if (!signup.ok) fail(`sign-up → ${signup.status} ${await signup.text()}`);
log('signed up');

const link = await waitForVerificationLink(inbox.token);
log('verification email received');
const verify = await fetch(link, { redirect: 'manual', headers: { cookie: cookieHeader() } });
absorbCookies(verify);
if (verify.status >= 400) fail(`verify link → ${verify.status}`);
log(`verified (${verify.status})`);

const me = await browser('/v1/me');
if (!me.ok) fail(`/v1/me after verify → ${me.status} — the verify redirect did not leave a session cookie`);
log(`session ok: ${JSON.stringify(await me.json())}`);

const minted = await browser('/v1/keys/rotate', { method: 'POST' });
if (minted.status !== 201) fail(`/v1/keys/rotate → ${minted.status} ${await minted.text()}`);
const { key } = (await minted.json()) as { key: string };
log(`api key minted (${key.slice(0, 6)}…)`);

const asAgent = (path: string, init: RequestInit = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

type Sandbox = {
  id: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  idleTimeoutMs: number | false;
  queuePosition?: number;
  estimatedWaitMs?: number;
  error?: string;
  connection?: { endpoint: string; token: string; deviceId: string };
};

const created = await asAgent('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ platform: PLATFORM }) });
if (created.status !== 202) fail(`create phone → ${created.status} ${await created.text()}`);
let phone = (await created.json()) as Sandbox;
const ttlMin = Math.round((Date.parse(phone.expiresAt) - Date.parse(phone.createdAt)) / 60_000);
const idleMin = phone.idleTimeoutMs === false ? 'off' : `${Math.round(phone.idleTimeoutMs / 60_000)}m`;
log(`phone ${phone.id} ${phone.status} — TTL ${ttlMin}m, idle ${idleMin}${ttlMin <= 15 ? ' (demo mode)' : ''}`);

const tCreate = performance.now();
while (phone.status === 'queued' || phone.status === 'preparing') {
  if (performance.now() - tCreate > 300_000) fail('phone did not reach running within 5 minutes');
  await sleep(2_000);
  const res = await asAgent(`/v1/sandboxes/${phone.id}`);
  phone = (await res.json()) as Sandbox;
  if (phone.status === 'queued') log(`queued #${phone.queuePosition ?? '?'} (~${Math.round((phone.estimatedWaitMs ?? 0) / 60_000)}m)`);
}
const conn =
  phone.status === 'running' && phone.connection
    ? phone.connection
    : fail(`phone ended ${phone.status}: ${phone.error ?? 'no error'}`);
log(`running after ${((performance.now() - tCreate) / 1000).toFixed(1)}s on ${conn.deviceId}`);

try {
  const device = createCloudSandboxBackend({ endpoint: conn.endpoint, token: conn.token });
  const tObs = performance.now();
  const snap = await device.snapshot({ interactiveOnly: true });
  log(`observe: ${snap.nodes.length} elements, app ${snap.appName ?? '?'} (${Math.round(performance.now() - tObs)}ms)`);
  if (snap.nodes.length === 0) fail('observe returned an empty screen');
  const shotPath = `/tmp/stranger-${phone.id}.png`;
  const tShot = performance.now();
  await device.screenshot({ path: shotPath });
  log(`screenshot → ${shotPath} (${Math.round(performance.now() - tShot)}ms)`);
} finally {
  const closed = await asAgent(`/v1/sandboxes/${phone.id}`, { method: 'DELETE' });
  log(`close → ${closed.status}`);
}

console.log(`\nSTRANGER TEST PASSED in ${since()} — a new user gets a working phone.\n`);
