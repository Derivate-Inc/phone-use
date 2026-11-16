#!/usr/bin/env bun
// One-command local cloud stack: control plane on :8080 + web app on :3000.
// Same-site (localhost↔localhost), so sessions and Google OAuth state work
// exactly like production. Reads .env for BETTER_AUTH_SECRET / GOOGLE_* keys.
// Google locally also needs http://localhost:8080/api/auth/callback/google
// added to the OAuth client's redirect URIs (one-time, Google console).

const env = {
  ...process.env,
  PHONE_USE_CLOUD_API_TOKEN: process.env.PHONE_USE_CLOUD_API_TOKEN ?? 'local-admin',
  PHONE_USE_CLOUD_WORKER_TOKEN: process.env.PHONE_USE_CLOUD_WORKER_TOKEN ?? 'local-worker',
  PHONE_USE_CLOUD_DB: process.env.PHONE_USE_CLOUD_DB ?? './data/dev-cloud.sqlite',
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'dev-secret-dev-secret-dev-secret-dev',
  BETTER_AUTH_URL: 'http://localhost:8080',
  PHONE_USE_TRUSTED_ORIGINS: 'http://localhost:3000,http://localhost:8080',
  PORT: '8080',
  HOST: '127.0.0.1',
};

const control = Bun.spawn(['bun', 'apps/api/src/control-plane-main.ts'], {
  env,
  stdout: 'inherit',
  stderr: 'inherit',
});
const console_ = Bun.spawn(['bun', 'run', 'dev'], {
  cwd: 'apps/web',
  env: { ...process.env, NEXT_PUBLIC_PHONE_USE_API: 'http://localhost:8080' },
  stdout: 'inherit',
  stderr: 'inherit',
});

const stop = () => {
  control.kill();
  console_.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race([control.exited, console_.exited]);
stop();
