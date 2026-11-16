import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { bearer } from './http.ts';
import { windowLimiter } from './rate-limit.ts';
import { CloudStore, type WaitlistClient } from './store.ts';
import type { WorkerHost } from './types.ts';

export type ControlPlaneOptions = {
  apiToken: string;
  workerToken: string;
  databasePath?: string | undefined;
  store?: CloudStore | undefined;
  /** Browser origins allowed to use cookie auth (web-app origins). */
  allowedOrigins?: string[] | undefined;
  /** Console origin used in device-flow verification URIs. */
  consoleOrigin?: string | undefined;
  /** Max queued+preparing+running phones per tenant (admin exempt). Default 5. */
  maxActivePerTenant?: number | undefined;
  /**
   * Cloud waitlist: only approved accounts may create phones; everyone else
   * gets the `cloud_waitlist` answer and is counted. On by default; a
   * self-hosted control plane turns it off with PHONE_USE_CLOUD_WAITLIST=0.
   */
  cloudWaitlist?: boolean | undefined;
  /** Where the waitlist answer sends people. Default https://phoneuse.dev/waitlist. */
  waitlistUrl?: string | undefined;
  /** Better Auth instance for web sessions (email+password). Optional: the
   * API works key-only without it. */
  auth?:
    | {
        handler: (request: Request) => Promise<Response>;
        api: { getSession: (input: { headers: Headers }) => Promise<unknown> };
      }
    | undefined;
};

// Demo mode (PHONE_USE_DEMO_MODE=1): a public link means many strangers and one
// small fleet, so sessions are short and everyone gets exactly one phone. The
// fleet then rotates in minutes instead of hours.
const DEMO = process.env.PHONE_USE_DEMO_MODE === '1';
// Outside demo mode the defaults are tunable: a launch can keep the hour-long
// TTL while reaping abandoned phones after a few minutes instead of fifteen.
const envMs = (key: string, fallback: number) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= 60_000 ? v : fallback;
};
const DEFAULT_TTL_MS = DEMO ? 10 * 60_000 : envMs('PHONE_USE_DEFAULT_TTL_MS', 60 * 60_000);
const DEFAULT_IDLE_MS = DEMO ? 3 * 60_000 : envMs('PHONE_USE_DEFAULT_IDLE_MS', 15 * 60_000);
const MAX_TTL_MS = DEMO ? 15 * 60_000 : 24 * 60 * 60_000;

/** The stable code clients branch on when a create is refused by the waitlist. */
export const CLOUD_WAITLIST_CODE = 'cloud_waitlist';
const DEFAULT_WAITLIST_URL = 'https://phoneuse.dev/waitlist';

type Vars = {
  Variables: {
    tenantId: string | undefined;
    isAdmin: boolean;
    /** May create cloud phones (always true when the waitlist is off). */
    cloudApproved: boolean;
    /** Authenticated by a console session cookie rather than a key. */
    viaSession: boolean;
    /** undefined = fleet-wide (admin); else pinned to the tenant's rows. */
    scope: string | undefined;
  };
};

/** JSON must be an object before any route reads its fields. */
async function jsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  const value: unknown = await request.json().catch(() => undefined);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createControlPlane(opts: ControlPlaneOptions): {
  fetch(request: Request): Promise<Response>;
  store: CloudStore;
  close(): void;
} {
  if (!opts.apiToken) throw new Error('control-plane apiToken is required');
  if (!opts.workerToken) throw new Error('control-plane workerToken is required');
  const store = opts.store ?? new CloudStore(opts.databasePath);
  const reaper = setInterval(() => store.reap(), 5_000);
  reaper.unref?.();

  const allowedOrigins = new Set(opts.allowedOrigins ?? []);
  // Prefer an explicit origin, then the console among the trusted origins
  // (app.* in prod, localhost in dev), then the production console.
  const consoleOrigin =
    opts.consoleOrigin ??
    process.env.PHONE_USE_CONSOLE_ORIGIN ??
    [...allowedOrigins].find((o) => o.includes('app.')) ??
    [...allowedOrigins][0] ??
    'https://app.phoneuse.dev';
  const log = (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
  };

  // Abuse ceilings, generous enough that no legitimate client notices.
  const createLimit = windowLimiter(30, 60_000);
  const rotateLimit = windowLimiter(10, 60_000);

  // ── cloud waitlist ───────────────────────────────────────────────────
  const waitlistOn =
    opts.cloudWaitlist ?? !['0', 'off', 'false'].includes(process.env.PHONE_USE_CLOUD_WAITLIST ?? '');
  const waitlistUrl = opts.waitlistUrl ?? process.env.PHONE_USE_WAITLIST_URL ?? DEFAULT_WAITLIST_URL;
  /** The one answer every refused create gets. `code` is what clients branch on. */
  const waitlistAnswer = () => ({
    error:
      `Cloud phones are on a waitlist. Join it at ${waitlistUrl}. ` +
      'phone-use still works on your own machine with the local simulator, and needs no account.',
    code: CLOUD_WAITLIST_CODE,
    waitlistUrl,
  });
  const CLIENTS: readonly WaitlistClient[] = ['cli', 'mcp', 'sdk', 'web'];
  const clientKind = (value: unknown, fallback: WaitlistClient = 'unknown'): WaitlistClient =>
    CLIENTS.includes(value as WaitlistClient) ? (value as WaitlistClient) : fallback;
  // The public waitlist routes are limited per caller. The limiter needs
  // something to tell callers apart, and the only thing an unauthenticated
  // request has is its address — so the key is a digest of the address under
  // a secret that lives only in this process. No address is kept, in memory
  // or on disk, and the digest means nothing after a restart.
  const callerSalt = randomBytes(16);
  const callerKey = (request: Request): string =>
    createHash('sha256')
      .update(callerSalt)
      .update(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown')
      .digest('base64url')
      .slice(0, 16);
  const attemptLimit = windowLimiter(20, 60_000);
  const attemptCeiling = windowLimiter(3_000, 60 * 60_000);
  const joinLimit = windowLimiter(5, 60_000);
  const joinCeiling = windowLimiter(500, 60 * 60_000);

  const app = new Hono<Vars>();

  // CORS: only known web-app origins get credentialed cross-origin access.
  // Everything else gets no CORS grant at all — direct API use is bearer-only
  // from non-browser clients, which need no CORS. (codex review #6)
  app.use(
    '*',
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
      allowHeaders: ['authorization', 'content-type', 'x-phone-use-client'],
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
      credentials: true,
    }),
  );

  // Request id + structured access log (worker chatter excluded — heartbeats
  // every few seconds would drown real traffic).
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    const started = Date.now();
    await next();
    c.res.headers.set('x-request-id', requestId);
    const path = c.req.path;
    if (path.startsWith('/v1/') && !path.startsWith('/v1/worker/')) {
      log(c.res.status >= 500 ? 'error' : 'info', 'http', {
        requestId,
        method: c.req.method,
        path,
        status: c.res.status,
        ms: Date.now() - started,
      });
    }
  });

  app.get('/healthz', (c) => c.json({ ok: true }));


  if (opts.auth) {
    const handler = opts.auth.handler;
    // The console reaches these routes through its own-origin proxy. A CDN
    // strips Set-Cookie from anything it may cache, and Better Auth's OAuth
    // callback redirect carries no cache-control — so the edge stamps
    // `public` on it and the session cookie dies in transit while the session
    // itself exists server-side. no-store on every auth response prevents it.
    app.all('/api/auth/*', async (c) => {
      const res = await handler(c.req.raw);
      const headers = new Headers(res.headers);
      const cookies = res.headers.getSetCookie?.() ?? [];
      if (cookies.length > 0) {
        headers.delete('set-cookie');
        for (const cookie of cookies) headers.append('set-cookie', cookie);
      }
      headers.set('cache-control', 'no-store');
      // Auth routes sit outside the /v1 request log; without this an OAuth
      // failure is completely invisible server-side. Cookie NAMES only —
      // values are session secrets and must never reach the logs.
      log(res.status >= 500 ? 'error' : 'info', 'auth', {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: res.status,
        setsCookies: cookies.map((k) => k.split('=')[0]),
      });
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    });
  }

  // The web app (Better Auth) owns signup now. The name-only bootstrap
  // endpoint is retired deliberately: documented 410, not a silent 404.
  app.post('/v1/signup', (c) =>
    c.json(
      { error: 'gone — sign up at the console (Better Auth)', docs: 'https://phoneuse.dev/docs/cloud/quickstart' },
      410,
    ),
  );

  // ── device authorization (RFC 8628) ──────────────────────────────────
  // start/poll are unauthenticated by design: the device code IS the secret,
  // and nothing is issued until a signed-in human approves the user code.
  const deviceStartLimit = windowLimiter(10, 60_000);
  const devicePollLimit = windowLimiter(120, 60_000);

  app.post('/v1/device/start', async (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!deviceStartLimit(ip)) return c.json({ error: 'rate limit: too many device logins' }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { clientName?: string };
    const started = store.startDeviceAuth(
      typeof body.clientName === 'string' ? body.clientName.slice(0, 64) : undefined,
    );
    return c.json(
      {
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        verificationUri: `${consoleOrigin}/device`,
        verificationUriComplete: `${consoleOrigin}/device?code=${started.userCode}`,
        expiresAt: started.expiresAt,
        intervalMs: 5000,
      },
      201,
    );
  });

  app.post('/v1/device/poll', async (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!devicePollLimit(ip)) return c.json({ error: 'slow_down' }, 429);
    const { deviceCode } = (await c.req.json().catch(() => ({}))) as { deviceCode?: string };
    if (!deviceCode) return c.json({ error: 'deviceCode is required' }, 400);
    const result = store.pollDeviceAuth(deviceCode);
    return c.json(result, result.status === 'not_found' ? 404 : 200);
  });

  // ── cloud waitlist: the two public routes ────────────────────────────
  // Both are unauthenticated by design and rate-limited. Neither stores
  // anything about the caller beyond what the body states.
  const waitlistBodyLimit = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: 'Request too large.' }, 413),
  });
  app.use('/v1/waitlist', waitlistBodyLimit);
  app.use('/v1/waitlist/attempts', waitlistBodyLimit);

  // `create` run while logged out never reaches POST /v1/sandboxes, so the
  // client reports the attempt here and it is counted as 'anonymous'.
  app.post('/v1/waitlist/attempts', async (c) => {
    if (!attemptLimit(callerKey(c.req.raw)) || !attemptCeiling('all')) {
      return c.json({ error: 'rate limit: too many attempts' }, 429);
    }
    const body = await jsonObject(c.req.raw);
    if (!body) return c.json({ error: 'A JSON object is required.' }, 400);
    store.recordWaitlistAttempt({
      account: 'anonymous',
      platform: body.platform === 'ios' || body.platform === 'android' ? body.platform : undefined,
      client: clientKind(body.client ?? c.req.header('x-phone-use-client')),
    });
    return c.json({ recorded: true, code: CLOUD_WAITLIST_CODE, waitlistUrl }, 202);
  });

  // The waitlist form: an email and what the person would use cloud phones for.
  app.post('/v1/waitlist', async (c) => {
    if (!joinLimit(callerKey(c.req.raw)) || !joinCeiling('all')) {
      return c.json({ error: 'Too many requests. Try again in a minute.' }, 429);
    }
    const body = await jsonObject(c.req.raw);
    if (!body) return c.json({ error: 'A JSON object is required.' }, 400);
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: 'Enter a valid email address.' }, 400);
    }
    const useCase = typeof body.useCase === 'string' ? body.useCase.trim().slice(0, 2_000) : '';
    store.joinWaitlist(email, useCase);
    // The same answer whether or not the email was already on the list, so
    // the form cannot be used to find out who has signed up.
    return c.json({ ok: true }, 201);
  });

  // Worker endpoints authenticate with the shared worker token only.
  app.use('/v1/worker/*', async (c, next) => {
    if (!safeEqual(bearer(c.req.raw), opts.workerToken)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  // Client auth resolves to a tenant. The configured apiToken remains valid as a
  // bootstrap/ops admin key so existing deployments and the CLI keep working;
  // every other key is a per-tenant key and sees only its own sandboxes.
  app.use('/v1/*', async (c, next) => {
    if (c.req.path.startsWith('/v1/worker/')) return next();
    const request = c.req.raw;
    let tenantId: string | undefined;
    let isAdmin = false;
    let cloudApproved = false;
    let viaSession = false;
    const key = bearer(request);
    if (safeEqual(key, opts.apiToken)) {
      isAdmin = true;
    } else if (key) {
      const tenant = store.tenantForKey(key);
      if (!tenant) return c.json({ error: 'unauthorized' }, 401);
      tenantId = tenant.id;
      isAdmin = tenant.isAdmin;
      cloudApproved = tenant.cloudApproved;
    } else if (opts.auth) {
      // No bearer key: a web session cookie resolves to the user's tenant.
      // Cookie-authenticated MUTATIONS additionally require an allowed
      // Origin (CSRF containment; cookies ride cross-site POSTs).
      if (request.method !== 'GET') {
        const origin = request.headers.get('origin');
        if (origin && !allowedOrigins.has(origin)) {
          return c.json({ error: 'origin not allowed for cookie auth' }, 403);
        }
      }
      const session = (await opts.auth.api.getSession({ headers: request.headers })) as {
        user?: { id: string; name?: string; email?: string; emailVerified?: boolean };
      } | null;
      if (!session?.user) return c.json({ error: 'unauthorized' }, 401);
      const tenant = store.tenantForUser(
        session.user.id,
        session.user.name || session.user.email || 'account',
        session.user.email,
      );
      if (!tenant) return c.json({ error: 'account disabled' }, 403);
      // Unverified emails may look around but not consume resources or mint
      // credentials (codex review #4). Google accounts arrive verified.
      const mutating =
        request.method !== 'GET' && (c.req.path === '/v1/sandboxes' || c.req.path === '/v1/keys/rotate');
      // An account on the waitlist that asks for a phone is told about the
      // waitlist (by the create handler, which creates nothing), not asked
      // to verify an email that would not get it a phone.
      const waitlisted = waitlistOn && !tenant.cloudApproved && c.req.path === '/v1/sandboxes';
      if (mutating && session.user.emailVerified === false && !waitlisted) {
        return c.json({ error: 'verify your email to create phones or keys' }, 403);
      }
      tenantId = tenant.id;
      isAdmin = tenant.isAdmin;
      cloudApproved = tenant.cloudApproved;
      viaSession = true;
    } else {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('tenantId', tenantId);
    c.set('isAdmin', isAdmin);
    c.set('cloudApproved', !waitlistOn || isAdmin || cloudApproved);
    c.set('viaSession', viaSession);
    // Admins may act fleet-wide; tenants are pinned to their own rows.
    c.set('scope', isAdmin ? undefined : tenantId);
    await next();
  });

  app.post('/v1/sandboxes', async (c) => {
    const tenantId = c.get('tenantId');
    if (!createLimit(tenantId ?? 'admin')) return c.json({ error: 'rate limit: too many creates' }, 429);
    const input = await jsonObject(c.req.raw);
    if (!input) return c.json({ error: 'A JSON object is required.' }, 400);
    if (input.platform !== 'ios' && input.platform !== 'android') {
      return c.json({ error: 'platform must be ios or android' }, 400);
    }
    // Cloud waitlist: an account that is not approved gets the stable
    // `cloud_waitlist` answer, and the attempt is counted. Nothing is
    // created, and the answer does not depend on capacity or quota.
    if (!c.get('cloudApproved')) {
      try {
        store.recordWaitlistAttempt({
          account: tenantId ?? 'anonymous',
          platform: input.platform,
          client: clientKind(c.req.header('x-phone-use-client'), c.get('viaSession') ? 'web' : 'unknown'),
        });
      } catch (error) {
        // The count is best-effort; the refusal is not.
        log('error', 'waitlist_attempt_not_recorded', { message: String(error) });
      }
      return c.json(waitlistAnswer(), 403);
    }
    const ttlMs = numberInRange(input.ttlMs, DEFAULT_TTL_MS, 60_000, MAX_TTL_MS);
    const idleTimeoutMs =
      input.idleTimeoutMs === false ? false : numberInRange(input.idleTimeoutMs, DEFAULT_IDLE_MS, 60_000, MAX_TTL_MS);
    // Fail fast instead of queueing forever: a platform with no live worker
    // (android today, unless self-hosting one) cannot be provisioned.
    if (!store.hasLiveHost(input.platform)) {
      return c.json({ error: `no ${input.platform} capacity available yet` }, 503);
    }
    // Per-tenant concurrency quota (admin exempt): rate limits alone don't
    // stop a tenant absorbing the whole fleet. (codex review #16)
    // PHONE_USE_MAX_ACTIVE_PER_TENANT raises the quota without turning demo
    // mode off, so a fleet demo can hold eight phones while public visitors
    // keep the one-phone limit and the short TTL.
    const envCap = Number(process.env.PHONE_USE_MAX_ACTIVE_PER_TENANT);
    const cap =
      opts.maxActivePerTenant ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : DEMO ? 1 : 5);
    if (tenantId && store.activeSandboxCount(tenantId) >= cap) {
      return c.json(
        {
          error:
            `active phone limit reached (${cap})` +
            (DEMO ? ' — close your phone to start another' : ''),
        },
        429,
      );
    }
    const created = store.createSandbox({ platform: input.platform, ttlMs, idleTimeoutMs, tenantId });
    return c.json({ ...created, ...(store.queueInfo(created.id) ?? {}) }, 202);
  });

  app.get('/v1/device/pending', (c) => {
    const code = c.req.query('code') ?? '';
    const pending = store.pendingDeviceAuth(code);
    return pending ? c.json(pending) : c.json({ error: 'unknown or expired code' }, 404);
  });

  app.post('/v1/device/approve', async (c) => {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ error: 'sign in to approve a device' }, 403);
    const { code } = (await c.req.json().catch(() => ({}))) as { code?: string };
    if (!code) return c.json({ error: 'code is required' }, 400);
    return store.approveDeviceAuth(code, tenantId)
      ? c.json({ ok: true })
      : c.json({ error: 'unknown or expired code' }, 404);
  });

  app.post('/v1/device/deny', async (c) => {
    const { code } = (await c.req.json().catch(() => ({}))) as { code?: string };
    if (!code) return c.json({ error: 'code is required' }, 400);
    return store.denyDeviceAuth(code) ? c.json({ ok: true }) : c.json({ error: 'unknown code' }, 404);
  });

  app.get('/v1/sandboxes', (c) => c.json(store.listSandboxes(c.get('scope'))));
  app.get('/v1/usage', (c) => c.json({ usage: store.listUsage(c.get('scope')) }));

  // Who am I — lets the web app validate a pasted key and greet the tenant.
  app.get('/v1/me', (c) => {
    const tenantId = c.get('tenantId');
    return c.json({
      tenantId: tenantId ?? null,
      name: tenantId ? (store.tenantName(tenantId) ?? null) : null,
      isAdmin: c.get('isAdmin'),
      keyCreatedAt: tenantId ? store.keyCreatedAt(tenantId) : null,
      // False means cloud phones are on a waitlist for this account.
      cloudApproved: c.get('cloudApproved'),
      ...(c.get('cloudApproved') ? {} : { waitlistUrl }),
    });
  });

  // Fleet health for operators/alerting: hosts with last-seen ages.
  app.get('/v1/admin/hosts', (c) => {
    if (!c.get('isAdmin')) return c.json({ error: 'admin token required' }, 403);
    return c.json({ hosts: store.listHosts() });
  });

  // Cloud waitlist for operators: the demand count, who is waiting, and the
  // form entries. scripts/cloud-waitlist.ts prints this.
  app.get('/v1/admin/waitlist', (c) => {
    if (!c.get('isAdmin')) return c.json({ error: 'admin token required' }, 403);
    return c.json({
      enabled: waitlistOn,
      ...store.waitlistSummary(),
      accounts: store.listWaitlistedAccounts(),
      formEntries: store.listWaitlistEntries(),
    });
  });

  // Approve an account for cloud phones (or put it back on the waitlist), by
  // tenant id or by email. Approving an email that has no account yet means
  // the account starts approved when it signs up.
  app.post('/v1/admin/cloud-approval', async (c) => {
    if (!c.get('isAdmin')) return c.json({ error: 'admin token required' }, 403);
    const body = await jsonObject(c.req.raw);
    if (!body) return c.json({ error: 'A JSON object is required.' }, 400);
    if (body.approved !== undefined && typeof body.approved !== 'boolean') {
      return c.json({ error: 'approved must be a boolean' }, 400);
    }
    const approved = body.approved !== false;
    if (typeof body.tenantId === 'string' && body.tenantId) {
      return store.setCloudApproval(body.tenantId, approved)
        ? c.json({ ok: true, approved, tenantId: body.tenantId })
        : c.json({ error: 'tenant not found' }, 404);
    }
    if (typeof body.email === 'string' && body.email.includes('@')) {
      const result = store.setCloudApprovalByEmail(body.email, approved);
      return c.json({ ok: true, approved, ...result, accountExists: result.tenantId !== null });
    }
    return c.json({ error: 'tenantId or email is required' }, 400);
  });

  // Rotate the caller's API key — returned once, stored hashed. Web-facing.
  app.post('/v1/keys/rotate', (c) => {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ error: 'sign in to rotate a key' }, 403);
    if (!rotateLimit(tenantId)) return c.json({ error: 'rate limit: too many rotations' }, 429);
    return c.json({ key: store.rotateKey(tenantId) }, 201);
  });

  // Admin-only: mint a tenant key. Returned once and never stored in the clear.
  app.post('/v1/tenants', async (c) => {
    if (!c.get('isAdmin')) return c.json({ error: 'admin token required' }, 403);
    const { name, cloudApproved } = (await c.req.json()) as { name?: string; cloudApproved?: unknown };
    if (!name) return c.json({ error: 'name is required' }, 400);
    // A tenant an operator mints is approved for cloud phones unless told otherwise.
    return c.json(store.createTenant(name, { cloudApproved: cloudApproved !== false }), 201);
  });

  app.get('/v1/sandboxes/:id', (c) => {
    const sandbox = store.getSandbox(c.req.param('id'), c.get('scope'));
    if (!sandbox) return c.json({ error: 'sandbox not found' }, 404);
    return c.json({ ...sandbox, ...(store.queueInfo(sandbox.id) ?? {}) });
  });
  app.get('/v1/sandboxes/:id/events', (c) => {
    // Same scope rule as GET /v1/sandboxes/:id — a tenant sees only its own.
    const scope = c.get('scope');
    const sandbox = store.getSandbox(c.req.param('id'), scope);
    if (!sandbox) return c.json({ error: 'sandbox not found' }, 404);
    return c.json({ events: store.listEvents(sandbox.id) });
  });
  app.delete('/v1/sandboxes/:id', (c) => {
    const sandbox = store.requestDelete(c.req.param('id'), c.get('scope'));
    return sandbox ? c.json(sandbox, 202) : c.json({ error: 'sandbox not found' }, 404);
  });

  app.post('/v1/worker/register', async (c) => {
    const host = (await c.req.json()) as WorkerHost;
    if (
      !host.id ||
      (host.platform !== 'ios' && host.platform !== 'android') ||
      !Number.isInteger(host.capacity) ||
      host.capacity < 1 ||
      !isHttpUrl(host.publicUrl)
    ) {
      return c.json({ error: 'invalid worker registration' }, 400);
    }
    store.registerHost(host);
    return c.json({ ok: true });
  });

  app.post('/v1/worker/heartbeat', async (c) => {
    const { hostId, reserved } = (await c.req.json()) as { hostId?: string; reserved?: number };
    return hostId && store.heartbeatHost(hostId, Number.isFinite(reserved) ? Number(reserved) : 0)
      ? c.json({ ok: true })
      : c.json({ error: 'worker not registered' }, 404);
  });

  app.post('/v1/worker/sandboxes/live', async (c) => {
    const { hostId } = (await c.req.json()) as { hostId?: string };
    if (!hostId) return c.json({ error: 'hostId is required' }, 400);
    return c.json({ ids: store.liveSandboxIdsForHost(hostId) });
  });

  app.post('/v1/worker/jobs/claim', async (c) => {
    const { hostId } = (await c.req.json()) as { hostId?: string };
    if (!hostId) return c.json({ error: 'hostId is required' }, 400);
    return c.json({ job: store.claimJob(hostId) ?? null });
  });

  app.post('/v1/worker/jobs/:id/:outcome{complete|fail}', async (c) => {
    const id = c.req.param('id');
    const input = (await c.req.json()) as {
      hostId?: string;
      kind?: 'create' | 'delete';
      deviceId?: string;
      name?: string;
      error?: string;
    };
    if (!input.hostId) return c.json({ error: 'hostId is required' }, 400);
    if (c.req.param('outcome') === 'fail') {
      return c.json(store.failJob(input.hostId, id, input.error ?? 'worker job failed') ?? {});
    }
    const sandbox =
      input.kind === 'create' && input.deviceId
        ? store.completeCreate(input.hostId, id, input.deviceId, input.name)
        : input.kind === 'delete'
          ? store.completeDelete(input.hostId, id)
          : undefined;
    return sandbox ? c.json(sandbox) : c.json({ error: 'job state changed' }, 409);
  });

  app.post('/v1/worker/sandboxes/:id/activity', async (c) => {
    const { hostId, event } = (await c.req.json()) as {
      hostId?: string;
      event?: { method?: unknown; detail?: unknown };
    };
    const id = c.req.param('id');
    if (!hostId || !store.touch(id, hostId))
      return c.json({ error: 'sandbox not running on this worker' }, 409);
    // Action log is best-effort: a malformed event must never fail the touch,
    // or the idle reaper starts killing phones over a logging bug.
    if (event && typeof event.method === 'string' && event.method.length <= 64) {
      const detail =
        typeof event.detail === 'string' ? event.detail.slice(0, 512) : null;
      try {
        store.recordEvent(id, event.method, detail);
      } catch {
        /* logged nothing; activity already touched */
      }
    }
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : String(error);
    // numberInRange and JSON body parsing are caller errors, not server faults.
    if (error instanceof BadRequest || /Failed to parse JSON|JSON Parse error/i.test(message)) {
      return c.json({ error: message }, 400);
    }
    const requestId = c.res.headers.get('x-request-id') ?? crypto.randomUUID().slice(0, 8);
    log('error', 'unhandled', { requestId, message });
    return c.json({ error: 'internal error', requestId }, 500);
  });

  return {
    fetch: (request: Request) => Promise.resolve(app.fetch(request)),
    store,
    close() {
      clearInterval(reaper);
      store.close();
    },
  };
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

class BadRequest extends Error {}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new BadRequest(`value must be between ${min} and ${max} milliseconds`);
  }
  return Math.round(value);
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
