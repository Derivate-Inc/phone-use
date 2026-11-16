#!/usr/bin/env bun
// Operator tool for the cloud waitlist. Talks to the control plane's admin
// routes, so it works against production or a local stack alike.
//
//   bun scripts/cloud-waitlist.ts count                 the demand count
//   bun scripts/cloud-waitlist.ts list                  who is waiting, and the form entries
//   bun scripts/cloud-waitlist.ts approve <email|ten_…> approve an account for cloud phones
//   bun scripts/cloud-waitlist.ts unapprove <email|ten_…>
//
// Environment:
//   PHONE_USE_CLOUD_API_TOKEN  the control plane's admin token (required)
//   PHONE_USE_CLOUD_URL        control plane URL (default https://api.phoneuse.dev)
//
// Approving an email that has no account yet is recorded: the account starts
// approved when that person signs up.

const api = (process.env.PHONE_USE_CLOUD_URL ?? 'https://api.phoneuse.dev').replace(/\/+$/, '');
const token = process.env.PHONE_USE_CLOUD_API_TOKEN;
const [command = 'count', target] = process.argv.slice(2);

if (!token) {
  console.error('PHONE_USE_CLOUD_API_TOKEN (the admin token) is required');
  process.exit(1);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    console.error(`${method} ${path} → ${response.status}: ${data.error ?? 'request failed'}`);
    process.exit(1);
  }
  return data;
}

type Summary = {
  enabled: boolean;
  attempts: {
    total: number;
    anonymous: number;
    signedIn: number;
    accounts: number;
    last24h: number;
    last7d: number;
    byPlatform: Record<string, number>;
    byClient: Record<string, number>;
  };
  entries: number;
  waitlistedAccounts: number;
  accounts: Array<{
    tenantId: string;
    name: string;
    email: string | null;
    createdAt: string;
    attempts: number;
    lastAttemptAt: string | null;
  }>;
  formEntries: Array<{ email: string; useCase: string; createdAt: string; approved: boolean }>;
};

const pairs = (record: Record<string, number>) =>
  Object.entries(record)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ') || 'none';

switch (command) {
  case 'count':
  case 'list': {
    const s = await call<Summary>('GET', '/v1/admin/waitlist');
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    console.log(`Cloud waitlist on ${api}${s.enabled ? '' : ' (the gate is OFF: everyone can create)'}`);
    console.log('');
    console.log(`Refused creates:    ${s.attempts.total}`);
    console.log(`  logged out:       ${s.attempts.anonymous}`);
    console.log(`  signed in:        ${s.attempts.signedIn} (from ${s.attempts.accounts} accounts)`);
    console.log(`  last 24 hours:    ${s.attempts.last24h}`);
    console.log(`  last 7 days:      ${s.attempts.last7d}`);
    console.log(`  by platform:      ${pairs(s.attempts.byPlatform)}`);
    console.log(`  by client:        ${pairs(s.attempts.byClient)}`);
    console.log(`Waitlist form:      ${s.entries} entries`);
    console.log(`Accounts waiting:   ${s.waitlistedAccounts}`);
    if (command === 'list') {
      console.log('');
      console.log('Accounts waiting (most attempts first):');
      for (const a of s.accounts) {
        console.log(
          `  ${a.tenantId}  ${(a.email ?? a.name).padEnd(32)} ${String(a.attempts).padStart(3)} attempts  joined ${a.createdAt.slice(0, 10)}`,
        );
      }
      if (s.accounts.length === 0) console.log('  none');
      console.log('');
      console.log('Waitlist form entries (newest first):');
      for (const e of s.formEntries) {
        console.log(`  ${e.createdAt.slice(0, 10)}  ${e.email}${e.approved ? '  [approved]' : ''}`);
        if (e.useCase) console.log(`              ${e.useCase.replace(/\s+/g, ' ')}`);
      }
      if (s.formEntries.length === 0) console.log('  none');
    }
    break;
  }
  case 'approve':
  case 'unapprove': {
    if (!target) {
      console.error(`usage: bun scripts/cloud-waitlist.ts ${command} <email|ten_…>`);
      process.exit(1);
    }
    const approved = command === 'approve';
    const result = await call<{ tenantId?: string | null; email?: string; accountExists?: boolean }>(
      'POST',
      '/v1/admin/cloud-approval',
      target.startsWith('ten_') ? { tenantId: target, approved } : { email: target, approved },
    );
    if (result.email && result.accountExists === false) {
      console.log(
        approved
          ? `${result.email} has no account yet. Recorded: the account will start approved when they sign up.`
          : `${result.email} has no account. Any earlier approval of this email is removed.`,
      );
    } else {
      console.log(
        `${result.email ?? result.tenantId} is ${approved ? 'approved for cloud phones' : 'back on the waitlist'}.`,
      );
    }
    break;
  }
  default:
    console.error('usage: bun scripts/cloud-waitlist.ts <count|list|approve|unapprove> [email|ten_…] [--json]');
    process.exit(1);
}
