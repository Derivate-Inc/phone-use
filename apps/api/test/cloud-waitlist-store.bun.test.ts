import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudStore } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'pu-waitlist-store-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A database as it was before the waitlist shipped: migrations 001–007 only. */
function legacyDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  for (const name of [
    '001_initial.sql',
    '002_tenants_usage.sql',
    '003_users.sql',
    '004_hardening.sql',
    '005_billing_fairness.sql',
    '006_device_auth.sql',
    '007_sandbox_events.sql',
  ]) {
    db.exec(readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
  }
  return db;
}

const columns = (store: CloudStore, table: string): string[] =>
  (store.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe('cloud approval flag', () => {
  test('existing auth users without a tenant are approved once, without approving later signups', () => {
    const path = join(dir, 'legacy-unvisited.sqlite');
    const legacy = legacyDatabase(path);
    legacy.exec('CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT NOT NULL)');
    legacy.query('INSERT INTO user VALUES (?, ?, ?)').run('user-unvisited', 'Unvisited', 'old@example.com');
    legacy.close();

    let store = new CloudStore(path);
    const existing = store.tenantForUser('user-unvisited', 'Unvisited', 'old@example.com')!;
    expect(existing.cloudApproved).toBe(true);
    store.setCloudApproval(existing.id, false);
    // This user signs up after the migration, but has no tenant on restart.
    store.db.query('INSERT INTO user VALUES (?, ?, ?)').run('user-later', 'Later', 'later@example.com');
    store.close();

    store = new CloudStore(path);
    expect(store.tenantForUser('user-later', 'Later', 'later@example.com')?.cloudApproved).toBe(false);
    expect(store.tenantForUser('user-unvisited', 'Unvisited', 'old@example.com')?.cloudApproved).toBe(false);
    expect(store.db.query('SELECT COUNT(*) AS n FROM tenants WHERE user_id = ?').get('user-unvisited')).toEqual({ n: 1 });
    store.close();
  });

  test('accounts that exist when the flag ships are approved; later signups are not', () => {
    const path = join(dir, 'legacy.sqlite');
    const legacy = legacyDatabase(path);
    legacy
      .query('INSERT INTO tenants (id, name, key_hash, is_admin, created_at, user_id) VALUES (?, ?, ?, 0, ?, ?)')
      .run('ten_existing', 'Existing', 'hash-existing', Date.now(), 'user-existing');
    legacy.close();

    // First start with the new code: the existing account is approved.
    let store = new CloudStore(path);
    expect(store.cloudApproved('ten_existing')).toBe(true);
    const newcomer = store.tenantForUser('user-new', 'Newcomer');
    expect(newcomer?.cloudApproved).toBe(false);
    store.close();

    // Later restarts must not approve the newcomer: the backfill runs once.
    for (let restart = 0; restart < 2; restart++) {
      store = new CloudStore(path);
      expect(store.cloudApproved('ten_existing')).toBe(true);
      expect(store.tenantForUser('user-new', 'Newcomer')?.cloudApproved).toBe(false);
      store.close();
    }
  });

  test('a console signup starts on the waitlist; an operator-minted tenant and an admin do not', () => {
    const store = new CloudStore(':memory:');
    const signup = store.tenantForUser('user-1', 'Signup');
    expect(signup?.cloudApproved).toBe(false);

    const minted = store.createTenant('minted');
    expect(store.tenantForKey(minted.key)?.cloudApproved).toBe(true);
    const waitlisted = store.createTenant('minted-waitlisted', { cloudApproved: false });
    expect(store.tenantForKey(waitlisted.key)?.cloudApproved).toBe(false);
    const admin = store.createTenant('ops', { admin: true, cloudApproved: false });
    expect(store.tenantForKey(admin.key)?.cloudApproved).toBe(true);

    expect(store.cloudApproved('ten_missing')).toBe(false);
    store.close();
  });

  test('approval can be given and taken back, and survives a key rotation', () => {
    const store = new CloudStore(':memory:');
    const signup = store.tenantForUser('user-1', 'Signup')!;
    expect(store.setCloudApproval(signup.id, true)).toBe(true);
    const key = store.rotateKey(signup.id);
    expect(store.tenantForKey(key)?.cloudApproved).toBe(true);
    expect(store.setCloudApproval(signup.id, false)).toBe(true);
    expect(store.tenantForKey(key)?.cloudApproved).toBe(false);
    expect(store.setCloudApproval('ten_missing', true)).toBe(false);
    store.close();
  });

  test('an email approved from the waitlist starts approved when it signs up', () => {
    const store = new CloudStore(':memory:');
    store.joinWaitlist('Ada@Example.com', 'testing my app');
    expect(store.setCloudApprovalByEmail(' ada@example.com ', true)).toEqual({
      email: 'ada@example.com',
      tenantId: null,
    });
    expect(store.tenantForUser('user-ada', 'Ada', 'ADA@example.com')?.cloudApproved).toBe(true);
    // Someone else who signs up is still on the waitlist.
    expect(store.tenantForUser('user-bob', 'Bob', 'bob@example.com')?.cloudApproved).toBe(false);
    // The use case given on the form is kept when the entry is approved.
    expect(store.listWaitlistEntries()).toEqual([
      expect.objectContaining({ email: 'ada@example.com', useCase: 'testing my app', approved: true }),
    ]);
    store.close();
  });
});

describe('waitlist records', () => {
  test('a refused attempt stores time, account, platform and client, and nothing about the machine', () => {
    const store = new CloudStore(':memory:');
    expect(columns(store, 'waitlist_attempts').sort()).toEqual(['account', 'client', 'id', 'platform', 'ts']);
    expect(columns(store, 'waitlist_entries').sort()).toEqual([
      'approved_at',
      'created_at',
      'email',
      'updated_at',
      'use_case',
    ]);

    const before = Date.now();
    store.recordWaitlistAttempt({ account: 'anonymous', platform: 'ios', client: 'cli' });
    store.recordWaitlistAttempt({ account: 'ten_a', platform: 'android', client: 'mcp' });
    store.recordWaitlistAttempt({ account: 'ten_a', platform: 'ios', client: 'sdk' });
    store.recordWaitlistAttempt({ account: 'anonymous', client: 'unknown' });

    const rows = store.db.query('SELECT * FROM waitlist_attempts ORDER BY id').all() as Array<{
      ts: number;
      account: string;
      platform: string | null;
      client: string;
    }>;
    expect(rows.map((r) => [r.account, r.platform, r.client])).toEqual([
      ['anonymous', 'ios', 'cli'],
      ['ten_a', 'android', 'mcp'],
      ['ten_a', 'ios', 'sdk'],
      ['anonymous', null, 'unknown'],
    ]);
    expect(rows.every((r) => r.ts >= before && r.ts <= Date.now())).toBe(true);

    expect(store.waitlistSummary().attempts).toEqual({
      total: 4,
      anonymous: 2,
      signedIn: 2,
      accounts: 1,
      last24h: 4,
      last7d: 4,
      byPlatform: { ios: 2, android: 1, unstated: 1 },
      byClient: { cli: 1, mcp: 1, sdk: 1, unknown: 1 },
    });
    store.close();
  });

  test('the waitlist form keeps one entry per email and does not lose an answer', () => {
    const store = new CloudStore(':memory:');
    store.joinWaitlist('Dev@Example.com', 'CI for my React Native app');
    store.joinWaitlist('dev@example.com', '');
    store.joinWaitlist('other@example.com', '');
    const entries = store.listWaitlistEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.email === 'dev@example.com')?.useCase).toBe('CI for my React Native app');
    store.joinWaitlist('dev@example.com', 'load tests');
    expect(store.listWaitlistEntries().find((e) => e.email === 'dev@example.com')?.useCase).toBe('load tests');
    expect(store.waitlistSummary().entries).toBe(2);
    store.close();
  });

  test('waitlisted accounts are listed with how often they asked', () => {
    const store = new CloudStore(':memory:');
    const quiet = store.tenantForUser('user-quiet', 'Quiet')!;
    const keen = store.tenantForUser('user-keen', 'Keen')!;
    store.createTenant('approved-by-hand');
    store.recordWaitlistAttempt({ account: keen.id, platform: 'ios', client: 'cli' });
    store.recordWaitlistAttempt({ account: keen.id, platform: 'ios', client: 'cli' });
    const accounts = store.listWaitlistedAccounts();
    expect(accounts.map((a) => [a.tenantId, a.attempts])).toEqual([
      [keen.id, 2],
      [quiet.id, 0],
    ]);
    expect(accounts[0]?.lastAttemptAt).not.toBeNull();
    expect(store.waitlistSummary().waitlistedAccounts).toBe(2);
    store.close();
  });
});
