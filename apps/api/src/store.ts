import { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DevicePlatform } from '@phone-use/sdk';
import type { Sandbox, SandboxStatus, WorkerHost, WorkerJob } from './types.ts';

type SandboxRow = {
  delete_requested_at: number | null;
  id: string;
  platform: DevicePlatform;
  status: SandboxStatus;
  host_id: string | null;
  connection_token: string;
  device_ref: string | null;
  name: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  last_active_at: number;
  idle_timeout_ms: number | null;
};

type HostRow = {
  id: string;
  platform: DevicePlatform;
  capacity: number;
  public_url: string;
};

const ACTIVE_STATUSES = "('preparing','running','draining')";
const HOST_STALE_MS = 30_000;
/** A host silent this long has lost its devices; its draining sandboxes stop counting toward quota. */
const HOST_DEAD_MS = 5 * 60_000;

export class CloudStore {
  readonly db: Database;

  constructor(path = process.env.PHONE_USE_CLOUD_DB ?? './data/phone-use-cloud.sqlite') {
    this.db = new Database(path, { create: true });
    // journal_mode is persisted in the file, but busy_timeout and synchronous are
    // per-connection: without them the 5s reaper and sub-second worker polling
    // produce SQLITE_BUSY that surfaces to callers as opaque 500s.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // foreign_keys is OFF by default and is per-connection, so the schema's
    // REFERENCES are inert without this.
    this.db.exec('PRAGMA foreign_keys = ON');
    // Default journal_size_limit is -1: a one-off WAL spike stays on disk forever.
    this.db.exec('PRAGMA journal_size_limit = 67108864');
    this.db.exec('PRAGMA temp_store = MEMORY');
    for (const migration of ['001_initial.sql', '002_tenants_usage.sql', '003_users.sql', '004_hardening.sql', '005_billing_fairness.sql', '006_device_auth.sql', '007_sandbox_events.sql']) {
      const file = fileURLToPath(new URL(`../migrations/${migration}`, import.meta.url));
      try {
        this.db.exec(readFileSync(file, 'utf8'));
      } catch (error) {
        // ALTER TABLE ADD COLUMN is not idempotent; re-running a migration on an
        // existing database is expected and safe to ignore.
        if (!/duplicate column name/i.test(String(error))) throw error;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  createSandbox(input: {
    platform: DevicePlatform;
    ttlMs: number;
    idleTimeoutMs: number | false;
    tenantId?: string | undefined;
  }): Sandbox {
    const now = Date.now();
    const id = `sbx_${randomUUID().replaceAll('-', '')}`;
    const token = randomBytes(32).toString('base64url');
    this.db
      .query(
        `INSERT INTO sandboxes
          (id, platform, status, connection_token, created_at, updated_at, expires_at, last_active_at, idle_timeout_ms, tenant_id)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.platform,
        token,
        now,
        now,
        now + input.ttlMs,
        now,
        input.idleTimeoutMs === false ? null : input.idleTimeoutMs,
        input.tenantId ?? null,
      );
    return this.getSandbox(id)!;
  }

  /** Scoped to a tenant; pass undefined only for admin/ops callers. */
  listSandboxes(tenantId?: string): Sandbox[] {
    const rows = (
      tenantId
        ? this.db.query('SELECT * FROM sandboxes WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100').all(tenantId)
        : this.db.query('SELECT * FROM sandboxes ORDER BY created_at DESC LIMIT 200').all()
    ) as SandboxRow[];
    return rows.map((row) => this.toSandbox(row));
  }

  getSandbox(id: string, tenantId?: string): Sandbox | undefined {
    const row = this.db.query('SELECT * FROM sandboxes WHERE id = ?').get(id) as
      | (SandboxRow & { tenant_id: string | null })
      | null;
    if (!row) return undefined;
    // A tenant must not be able to probe another tenant's sandbox ids.
    if (tenantId && row.tenant_id !== tenantId) return undefined;
    return this.toSandbox(row);
  }

  requestDelete(id: string, tenantId?: string): Sandbox | undefined {
    const current = this.getSandbox(id, tenantId);
    if (!current) return undefined;
    const now = Date.now();
    if (current.status === 'queued' || current.status === 'failed') {
      this.db
        .query("UPDATE sandboxes SET status = 'closed', updated_at = ?, delete_requested_at = ? WHERE id = ?")
        .run(now, now, id);
    } else if (current.status === 'preparing' || current.status === 'running') {
      this.db
        .query("UPDATE sandboxes SET status = 'draining', updated_at = ?, delete_requested_at = ? WHERE id = ?")
        .run(now, now, id);
    }
    return this.getSandbox(id);
  }

  // ── device authorization (RFC 8628) ──────────────────────────────────
  /** Start a device flow; returns the pair the CLI polls with and the human types. */
  startDeviceAuth(clientName?: string): { deviceCode: string; userCode: string; expiresAt: number } {
    const now = Date.now();
    // Crockford-ish alphabet: no 0/O/1/I, so codes read aloud unambiguously.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const pick = (n: number) =>
      Array.from(crypto.getRandomValues(new Uint8Array(n)))
        .map((b) => alphabet[b % alphabet.length])
        .join('');
    const deviceCode = crypto.randomUUID().replace(/-/g, '');
    const userCode = `${pick(4)}-${pick(4)}`;
    const expiresAt = now + 15 * 60_000;
    this.db
      .query(
        `INSERT INTO device_auth (device_code, user_code, client_name, status, created_at, expires_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(deviceCode, userCode, clientName ?? null, now, expiresAt);
    return { deviceCode, userCode, expiresAt };
  }

  /** The CLI's poll. Returns the key exactly once, then clears it. */
  pollDeviceAuth(deviceCode: string): { status: string; key?: string } {
    const row = this.db.query('SELECT * FROM device_auth WHERE device_code = ?').get(deviceCode) as
      | { status: string; api_key: string | null; expires_at: number }
      | null;
    if (!row) return { status: 'not_found' };
    if (row.status === 'pending' && row.expires_at <= Date.now()) return { status: 'expired' };
    if (row.status === 'approved' && row.api_key) {
      this.db.query('DELETE FROM device_auth WHERE device_code = ?').run(deviceCode);
      return { status: 'approved', key: row.api_key };
    }
    return { status: row.status };
  }

  /** What the console shows on the approval screen. */
  pendingDeviceAuth(userCode: string): { clientName: string | null; expiresAt: number } | undefined {
    const row = this.db
      .query("SELECT * FROM device_auth WHERE user_code = ? AND status = 'pending'")
      .get(userCode.trim().toUpperCase()) as
      | { client_name: string | null; expires_at: number }
      | null;
    if (!row || row.expires_at <= Date.now()) return undefined;
    return { clientName: row.client_name, expiresAt: row.expires_at };
  }

  /** Approve: mint the tenant's key now so the CLI's next poll collects it. */
  approveDeviceAuth(userCode: string, tenantId: string): boolean {
    const code = userCode.trim().toUpperCase();
    const row = this.db
      .query("SELECT * FROM device_auth WHERE user_code = ? AND status = 'pending'")
      .get(code) as { expires_at: number } | null;
    if (!row || row.expires_at <= Date.now()) return false;
    const key = this.rotateKey(tenantId);
    this.db
      .query("UPDATE device_auth SET status = 'approved', tenant_id = ?, api_key = ?, approved_at = ? WHERE user_code = ?")
      .run(tenantId, key, Date.now(), code);
    return true;
  }

  denyDeviceAuth(userCode: string): boolean {
    const result = this.db
      .query("UPDATE device_auth SET status = 'denied' WHERE user_code = ? AND status = 'pending'")
      .run(userCode.trim().toUpperCase());
    return result.changes > 0;
  }

  registerHost(host: WorkerHost): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO hosts (id, platform, capacity, public_url, metadata_json, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           platform = excluded.platform,
           capacity = excluded.capacity,
           public_url = excluded.public_url,
           metadata_json = excluded.metadata_json,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        host.id,
        host.platform,
        host.capacity,
        host.publicUrl.replace(/\/+$/, ''),
        JSON.stringify(host.metadata ?? {}),
        now,
        now,
      );
  }

  /** A worker for this platform has been seen recently. */
  /**
   * Where this sandbox sits in the queue for its platform (1 = next up), plus
   * a rough wait built from the fleet's capacity and how long creates take.
   * Undefined once it is no longer queued.
   */
  queueInfo(id: string): { queuePosition: number; estimatedWaitMs: number } | undefined {
    const row = this.db
      .query("SELECT rowid, platform, created_at, status FROM sandboxes WHERE id = ?")
      .get(id) as { rowid: number; platform: DevicePlatform; created_at: number; status: string } | null;
    if (!row || row.status !== 'queued') return undefined;
    // Tie-break on insertion order: a burst of arrivals shares a millisecond,
    // and telling every one of them "you're next" is worse than no queue at all.
    const ahead = this.db
      .query(
        `SELECT COUNT(*) AS c FROM sandboxes
         WHERE platform = ? AND status IN ('queued','preparing')
           AND (created_at < ? OR (created_at = ? AND rowid < ?))`,
      )
      .get(row.platform, row.created_at, row.created_at, row.rowid) as { c: number };
    const position = ahead.c + 1;
    // Total slots across live hosts; a slot frees roughly every idle/TTL cycle,
    // but the common case is a short demo session, so estimate from capacity.
    const fleet = this.db
      .query('SELECT COALESCE(SUM(capacity), 0) AS slots FROM hosts WHERE platform = ? AND last_seen_at > ?')
      .get(row.platform, Date.now() - HOST_STALE_MS) as { slots: number };
    const slots = Math.max(1, fleet.slots);
    const cycleMs = Number(process.env.PHONE_USE_QUEUE_CYCLE_MS ?? 3 * 60_000);
    return { queuePosition: position, estimatedWaitMs: Math.ceil(position / slots) * cycleMs };
  }

  hasLiveHost(platform: DevicePlatform): boolean {
    const row = this.db
      .query('SELECT COUNT(*) AS count FROM hosts WHERE platform = ? AND last_seen_at > ?')
      .get(platform, Date.now() - HOST_STALE_MS) as { count: number };
    return row.count > 0;
  }

  heartbeatHost(id: string, reserved = 0): boolean {
    return (
      this.db
        .query(
          `UPDATE hosts
           SET last_seen_at = ?,
               metadata_json = json_set(COALESCE(NULLIF(metadata_json, ''), '{}'), '$.reserved', ?)
           WHERE id = ?`,
        )
        .run(Date.now(), reserved, id).changes > 0
    );
  }

  claimJob(hostId: string): WorkerJob | undefined {
    const claim = this.db.transaction((): WorkerJob | undefined => {
      const host = this.db.query('SELECT * FROM hosts WHERE id = ?').get(hostId) as HostRow | null;
      if (!host) return undefined;
      const now = Date.now();

      const deletion = this.db
        .query(
          "SELECT * FROM sandboxes WHERE host_id = ? AND status = 'draining' ORDER BY updated_at LIMIT 1",
        )
        .get(hostId) as SandboxRow | null;
      if (deletion) return { kind: 'delete', sandbox: this.toSandbox(deletion) };

      const active = (
        this.db
          .query(`SELECT COUNT(*) AS count FROM sandboxes WHERE host_id = ? AND status IN ${ACTIVE_STATUSES}`)
          .get(hostId) as { count: number }
      ).count;
      // Warm-pool devices are real processes on the host even though no sandbox
      // row points at them; they must count against capacity.
      const reserved = Number(
        (
          this.db
            .query("SELECT json_extract(metadata_json, '$.reserved') AS r FROM hosts WHERE id = ?")
            .get(hostId) as { r: number | null } | null
        )?.r ?? 0,
      );
      if (active + reserved >= host.capacity) return undefined;

      const queued = this.db
        .query("SELECT * FROM sandboxes WHERE platform = ? AND status = 'queued' ORDER BY created_at LIMIT 1")
        .get(host.platform) as SandboxRow | null;
      if (!queued) return undefined;
      const changed = this.db
        .query(
          "UPDATE sandboxes SET status = 'preparing', host_id = ?, updated_at = ?, operation_started_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(hostId, now, now, queued.id).changes;
      if (changed !== 1) return undefined;
      const sandbox = this.getSandbox(queued.id)!;
      return { kind: 'create', sandbox, connectionToken: queued.connection_token };
    });
    return claim.immediate();
  }

  completeCreate(hostId: string, id: string, deviceRef: string, name?: string): Sandbox | undefined {
    const now = Date.now();
    this.db
      .query(
        `UPDATE sandboxes
         SET status = 'running', device_ref = ?, name = ?, error = NULL, updated_at = ?, last_active_at = ?
         WHERE id = ? AND host_id = ? AND status = 'preparing'`,
      )
      .run(deviceRef, name ?? null, now, now, id, hostId);
    return this.getSandbox(id);
  }

  completeDelete(hostId: string, id: string): Sandbox | undefined {
    this.db
      .query(
        "UPDATE sandboxes SET status = 'closed', updated_at = ?, operation_started_at = NULL WHERE id = ? AND host_id = ? AND status = 'draining'",
      )
      .run(Date.now(), id, hostId);
    this.recordUsage(id, 'closed');
    return this.getSandbox(id);
  }

  /**
   * Write the billing record for a sandbox that has reached a terminal state.
   * Idempotent: the sandbox id is the primary key, so a retried completion cannot
   * double-bill.
   */
  recordUsage(id: string, endReason: string): void {
    const row = this.db.query('SELECT * FROM sandboxes WHERE id = ?').get(id) as
      | (SandboxRow & { tenant_id: string | null })
      | null;
    if (!row) return;
    const endedAt = Date.now();
    // Bill to when deletion was REQUESTED, not when the worker got around to it:
    // a stuck queue or offline worker is our lag, not the customer's minutes.
    const billedUntil = row.delete_requested_at ? Math.min(endedAt, row.delete_requested_at) : endedAt;
    this.db
      .query(
        `INSERT OR IGNORE INTO usage
           (sandbox_id, tenant_id, platform, host_id, started_at, ended_at, billed_ms, end_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.tenant_id,
        row.platform,
        row.host_id,
        row.created_at,
        endedAt,
        Math.max(0, billedUntil - row.created_at),
        endReason,
      );
  }

  /** Billing rows, newest first; scoped to a tenant unless an admin asks for all. */
  listUsage(tenantId?: string, limit = 500): unknown[] {
    return tenantId
      ? this.db
          .query('SELECT * FROM usage WHERE tenant_id = ? ORDER BY ended_at DESC LIMIT ?')
          .all(tenantId, limit)
      : this.db.query('SELECT * FROM usage ORDER BY ended_at DESC LIMIT ?').all(limit);
  }

  // --- tenants -------------------------------------------------------------

  createTenant(
    name: string,
    opts: { admin?: boolean; userId?: string } = {},
  ): { id: string; name: string; key: string } {
    const id = `ten_${randomUUID().replaceAll('-', '')}`;
    const key = `pk_${randomBytes(24).toString('base64url')}`;
    this.db
      .query(
        'INSERT INTO tenants (id, name, key_hash, is_admin, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, hashKey(key), opts.admin ? 1 : 0, Date.now(), opts.userId ?? null);
    return { id, name, key };
  }

  /**
   * The tenant owned by a console user; created on first session. A DISABLED
   * tenant denies access outright (undefined) — previously it silently minted
   * a fresh tenant, bypassing suspension. UNIQUE(user_id) makes the create
   * race safe: the loser of a concurrent first-login re-reads.
   */
  tenantForUser(
    userId: string,
    name: string,
  ): { id: string; name: string; isAdmin: boolean } | undefined {
    const read = () =>
      this.db.query('SELECT id, name, is_admin, disabled_at FROM tenants WHERE user_id = ?').get(userId) as
        | { id: string; name: string; is_admin: number; disabled_at: number | null }
        | null;
    let row = read();
    if (!row) {
      try {
        this.createTenant(name, { userId });
      } catch {
        /* lost the UNIQUE(user_id) race to a concurrent first login — re-read */
      }
      row = read();
    }
    if (!row || row.disabled_at != null) return undefined;
    return { id: row.id, name: row.name, isAdmin: row.is_admin === 1 };
  }

  /** Queued/preparing/running phones owned by a tenant (quota input). */
  activeSandboxCount(tenantId: string): number {
    const row = this.db
      .query(
        // A phone draining on a host that has gone silent stays draining (a
        // returning worker must still collect its device) but no longer holds
        // the tenant's quota — at the demo cap of one that was a permanent lockout.
        `SELECT COUNT(*) AS count FROM sandboxes s LEFT JOIN hosts h ON h.id = s.host_id
         WHERE s.tenant_id = ?
           AND (s.status IN ('queued','preparing','running')
                OR (s.status = 'draining' AND (h.last_seen_at IS NULL OR h.last_seen_at >= ?)))`,
      )
      .get(tenantId, Date.now() - HOST_DEAD_MS) as { count: number };
    return row.count;
  }

  /** Hosts with liveness ages, for /v1/admin/hosts. */
  listHosts(): Array<{ id: string; platform: string; capacity: number; lastSeenMsAgo: number }> {
    const rows = this.db
      .query('SELECT id, platform, capacity, last_seen_at FROM hosts ORDER BY id')
      .all() as Array<{ id: string; platform: string; capacity: number; last_seen_at: number }>;
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      capacity: r.capacity,
      lastSeenMsAgo: now - r.last_seen_at,
    }));
  }

  keyCreatedAt(tenantId: string): number | null {
    const row = this.db.query('SELECT key_created_at FROM tenants WHERE id = ?').get(tenantId) as {
      key_created_at: number | null;
    } | null;
    return row?.key_created_at ?? null;
  }

  /** Rotate a tenant's API key; the new key is returned once, stored hashed. */
  rotateKey(tenantId: string): string {
    const key = `pk_${randomBytes(24).toString('base64url')}`;
    this.db
      .query('UPDATE tenants SET key_hash = ?, key_created_at = ? WHERE id = ?')
      .run(hashKey(key), Date.now(), tenantId);
    return key;
  }

  tenantName(id: string): string | undefined {
    const row = this.db.query('SELECT name FROM tenants WHERE id = ?').get(id) as { name: string } | null;
    return row?.name;
  }

  /** Resolve a bearer key to a tenant. Undefined when unknown or disabled. */
  tenantForKey(key: string | undefined): { id: string; name: string; isAdmin: boolean } | undefined {
    if (!key) return undefined;
    const row = this.db
      .query('SELECT id, name, is_admin FROM tenants WHERE key_hash = ? AND disabled_at IS NULL')
      .get(hashKey(key)) as { id: string; name: string; is_admin: number } | null;
    return row ? { id: row.id, name: row.name, isAdmin: row.is_admin === 1 } : undefined;
  }

  failJob(hostId: string, id: string, message: string): Sandbox | undefined {
    // A failure that still holds a device goes to 'draining', not 'failed', so the
    // device is actually destroyed; the error is preserved either way.
    this.db
      .query(
        `UPDATE sandboxes
         SET status = CASE WHEN device_ref IS NULL THEN 'failed' ELSE 'draining' END,
             error = ?, updated_at = ?
         WHERE id = ? AND host_id = ? AND status IN ('preparing','draining')`,
      )
      .run(message.slice(0, 2_000), Date.now(), id, hostId);
    const sandbox = this.getSandbox(id);
    if (sandbox?.status === 'failed') this.recordUsage(id, 'failed');
    return sandbox;
  }

  /** Ids this host is still expected to hold a device for. */
  liveSandboxIdsForHost(hostId: string): string[] {
    return (
      this.db
        .query(`SELECT id FROM sandboxes WHERE host_id = ? AND status IN ${ACTIVE_STATUSES}`)
        .all(hostId) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  touch(id: string, hostId: string): boolean {
    return (
      this.db
        .query(
          "UPDATE sandboxes SET last_active_at = ?, updated_at = ? WHERE id = ? AND host_id = ? AND status = 'running'",
        )
        .run(Date.now(), Date.now(), id, hostId).changes > 0
    );
  }

  /** Append one action-log row; tenant denormalized so events outlive reap(). */
  recordEvent(sandboxId: string, method: string, detail: string | null): boolean {
    const row = this.db.query('SELECT tenant_id FROM sandboxes WHERE id = ?').get(sandboxId) as
      | { tenant_id: string | null }
      | null;
    if (!row) return false;
    this.db
      .query('INSERT INTO sandbox_events (sandbox_id, tenant_id, ts, method, detail) VALUES (?, ?, ?, ?, ?)')
      .run(sandboxId, row.tenant_id, Date.now(), method, detail);
    return true;
  }

  listEvents(sandboxId: string, tenantId?: string): Array<{ ts: number; method: string; detail: string | null }> {
    return this.db
      .query(
        `SELECT ts, method, detail FROM sandbox_events
         WHERE sandbox_id = ? ${tenantId ? 'AND tenant_id = ?' : ''} ORDER BY ts ASC LIMIT 2000`,
      )
      .all(...(tenantId ? [sandboxId, tenantId] : [sandboxId])) as Array<{
      ts: number;
      method: string;
      detail: string | null;
    }>;
  }

  reap(): number {
    const now = Date.now();
    this.db
      .query("DELETE FROM sandboxes WHERE status IN ('closed','failed') AND updated_at < ?")
      .run(now - 7 * 24 * 60 * 60_000);
    this.db.query('DELETE FROM sandbox_events WHERE ts < ?').run(now - 30 * 24 * 60 * 60_000);
    this.db.query('DELETE FROM device_auth WHERE expires_at < ?').run(now - 60 * 60_000);
    const staleOperation = now - 10 * 60_000;
    const result = this.db
      .query(
        `UPDATE sandboxes
         SET status = CASE
               -- Only jump straight to closed when no device was ever provisioned.
               -- Anything holding a device must drain so a worker destroys it,
               -- even if that worker is currently offline: it adopts on restart.
               WHEN device_ref IS NULL AND host_id IS NULL THEN 'closed'
               ELSE 'draining'
             END, updated_at = ?, delete_requested_at = COALESCE(delete_requested_at, updated_at)
         WHERE status IN ('queued','preparing','running')
           AND (
             expires_at <= ?
             OR (idle_timeout_ms IS NOT NULL AND last_active_at + idle_timeout_ms <= ?)
             OR (status = 'preparing' AND operation_started_at < ?)
           )`,
      )
      .run(now, now, now, staleOperation);
    return result.changes;
  }

  private toSandbox(row: SandboxRow): Sandbox {
    const host = row.host_id
      ? (this.db.query('SELECT * FROM hosts WHERE id = ?').get(row.host_id) as HostRow | null)
      : null;
    const hostOnline = host
      ? ((
          this.db.query('SELECT last_seen_at FROM hosts WHERE id = ?').get(host.id) as {
            last_seen_at: number;
          } | null
        )?.last_seen_at ?? 0)
      : 0;
    return {
      id: row.id,
      platform: row.platform,
      status: row.status,
      ...(row.name ? { name: row.name } : {}),
      ...(row.host_id ? { hostId: row.host_id } : {}),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      lastActiveAt: new Date(row.last_active_at).toISOString(),
      idleTimeoutMs: row.idle_timeout_ms ?? false,
      ...(row.error ? { error: row.error } : {}),
      ...(row.status === 'running' && row.device_ref && host && hostOnline >= Date.now() - HOST_STALE_MS
        ? {
            connection: {
              endpoint: `${host.public_url}/v1/device/${row.id}`,
              token: row.connection_token,
              deviceId: row.device_ref,
              capabilities: [
                'snapshot',
                'screenshot',
                'press',
                'longPress',
                'fill',
                'type',
                'key',
                'scroll',
                'waitForText',
                'alert',
                'home',
                'back',
                'openApp',
                'openUrl',
                'listApps',
                'closeSession',
              ],
            },
          }
        : {}),
    };
  }
}

/** API keys are stored only as digests, so a database leak does not leak keys. */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
