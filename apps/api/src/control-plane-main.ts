#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { startHostAlerts } from './alerts.ts';
import { createAuth, migrateAuth } from './auth.ts';
import { createControlPlane } from './control-plane.ts';

const apiToken = process.env.PHONE_USE_CLOUD_API_TOKEN;
const workerToken = process.env.PHONE_USE_CLOUD_WORKER_TOKEN;
if (!apiToken || !workerToken) {
  console.error('PHONE_USE_CLOUD_API_TOKEN and PHONE_USE_CLOUD_WORKER_TOKEN are required');
  process.exit(1);
}

const databasePath = process.env.PHONE_USE_CLOUD_DB ?? './data/phone-use-cloud.sqlite';
await mkdir(dirname(databasePath), { recursive: true });
// localhost is a credentialed-CORS + CSRF bypass for any local process; it
// belongs in dev defaults only.
const defaultOrigins =
  process.env.NODE_ENV === 'production'
    ? 'https://app.phoneuse.dev,https://www.phoneuse.dev'
    : 'https://app.phoneuse.dev,https://www.phoneuse.dev,http://localhost:3000';
const allowedOrigins = (process.env.PHONE_USE_TRUSTED_ORIGINS ?? defaultOrigins).split(',');
// Console sessions (email+password) — enabled when a secret is configured.
let auth: ReturnType<typeof createAuth> | undefined;
if (process.env.BETTER_AUTH_SECRET) {
  auth = createAuth({
    databasePath,
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    trustedOrigins: allowedOrigins,
  });
  await migrateAuth(auth);
} else {
  console.warn('BETTER_AUTH_SECRET not set — console login disabled, API keys only');
}

const control = createControlPlane({
  apiToken,
  workerToken,
  databasePath,
  allowedOrigins,
  auth,
});
// Worker-down mail (hardening epic): silent >2min → one email per outage.
const stopAlerts = startHostAlerts({
  store: control.store,
  resendApiKey: process.env.RESEND_API_KEY,
  to: process.env.PHONE_USE_ALERT_EMAIL,
});

const port = Number(process.env.PORT ?? 8080);
const hostname = process.env.HOST ?? '127.0.0.1';
const server = Bun.serve({ port, hostname, fetch: control.fetch });

console.log(`phone-use control plane listening on ${server.url}`);

async function shutdown(): Promise<void> {
  await server.stop();
  stopAlerts();
  control.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
