import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { USER_CONFIG_PATH } from './settings.ts';

// `phone-use login` — browser handoff, the same shape as vercel/fly/railway:
// the CLI listens on a random localhost port, opens the console with ?cli=<port>,
// the signed-in user approves, the console redirects back with a fresh API key,
// and the CLI persists it to ~/.phone-use/config.json for every later command.

const DEFAULT_API = 'https://api.phoneuse.dev';

function consoleUrlFor(api: string): string {
  if (api.includes('localhost') || api.includes('127.0.0.1')) return 'http://localhost:3000/cloud';
  if (api === DEFAULT_API) return 'https://app.phoneuse.dev';
  return `${api.replace(/\/$/, '')}/`; // self-hosted: control plane serves its own page
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(USER_CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeConfig(values: Record<string, unknown>): void {
  mkdirSync(dirname(USER_CONFIG_PATH), { recursive: true });
  writeFileSync(USER_CONFIG_PATH, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  chmodSync(USER_CONFIG_PATH, 0o600);
}

export async function runLogin(args: string[]): Promise<number> {
  const apiFlag = args.indexOf('--api');
  const api =
    (apiFlag !== -1 ? args[apiFlag + 1] : undefined) ?? process.env.PHONE_USE_CLOUD_URL ?? DEFAULT_API;

  // Self-hosters (or anyone) can skip the browser handoff entirely:
  //   phone-use login --key pk_…
  const keyFlag = args.indexOf('--key');
  if (keyFlag !== -1) {
    const manual = args[keyFlag + 1];
    if (!manual?.startsWith('pk_')) {
      console.error('usage: phone-use login --key pk_…');
      return 1;
    }
    const me = await fetch(`${api}/v1/me`, { headers: { authorization: `Bearer ${manual}` } })
      .then((r) => (r.ok ? (r.json() as Promise<{ name?: string }>) : undefined))
      .catch(() => undefined);
    if (!me) {
      console.error(`That key did not validate against ${api}.`);
      return 1;
    }
    writeConfig({ ...readConfig(), PHONE_USE_CLOUD_URL: api, PHONE_USE_CLOUD_TOKEN: manual });
    console.log(`Signed in as ${me.name ?? 'account'} → ${USER_CONFIG_PATH}`);
    return 0;
  }
  // Headless-safe path (RFC 8628 device flow): no browser to open, no
  // localhost callback to reach — the shape that works over SSH, in Docker,
  // in CI, and on remote dev boxes. Chosen automatically when there's clearly
  // no desktop session, or forced with --device.
  const headless =
    Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.CI) ||
    (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  if (args.includes('--device') || (headless && !args.includes('--browser'))) {
    return runDeviceLogin(api);
  }

  const consoleFlag = args.indexOf('--console');
  const consoleUrl = (consoleFlag !== -1 ? args[consoleFlag + 1] : undefined) ?? consoleUrlFor(api);

  const state = crypto.randomUUID().replace(/-/g, '');
  let resolveKey: (key: string) => void;
  const received = new Promise<string>((resolve) => {
    resolveKey = resolve;
  });

  const page = (title: string, body: string, ok: boolean) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>phone-use</title>
<body style="margin:0;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#111113">
  <div style="text-align:center;padding:2rem">
    <div style="width:44px;height:44px;margin:0 auto 1.1rem;border-radius:50%;display:grid;place-items:center;background:${ok ? '#e8f7ee' : '#fdeeee'}">
      ${
        ok
          ? '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#16a34a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>'
          : '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l8 8M14 6l-8 8"/></svg>'
      }
    </div>
    <h2 style="margin:0;font-size:1.15rem;letter-spacing:-0.02em">${title}</h2>
    <p style="margin:0.4rem 0 0;color:#6f6f78;font-size:0.9rem;max-width:34ch">${body}</p>
  </div>`;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/callback') {
        const key = url.searchParams.get('key');
        // The nonce stops any local page from force-feeding this CLI a key.
        if (key && url.searchParams.get('state') === state) {
          resolveKey(key);
          return new Response(
            page(
              'Connected',
              'Authentication successful. You can close this tab and return to the terminal.',
              true,
            ),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        }
        return new Response(
          page(
            'Sign-in link was stale',
            'This tab and the terminal got out of sync. Refresh the console tab, then run <code>phone-use login</code> again.',
            false,
          ),
          { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      return new Response(
        page(
          'Nothing here',
          'This is the phone-use CLI sign-in helper. Run <code>phone-use login</code> to start.',
          false,
        ),
        {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      );
    },
  });

  const authorize = `${consoleUrl}${consoleUrl.includes('?') ? '&' : '?'}cli=${server.port}&state=${state}`;
  console.log(`Opening ${authorize}`);
  console.log('Sign in and approve the CLI. Waiting…');
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    Bun.spawn([opener, authorize], { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    console.log('Could not open a browser automatically — open the URL above yourself.');
  }

  const key = await Promise.race([received, Bun.sleep(300_000).then(() => undefined)]);
  server.stop(true);
  if (!key) {
    console.error('Timed out after 5 minutes — run `phone-use login` again.');
    return 1;
  }

  // Prove the key before persisting it.
  const me = await fetch(`${api}/v1/me`, { headers: { authorization: `Bearer ${key}` } })
    .then((r) => (r.ok ? (r.json() as Promise<{ name?: string }>) : undefined))
    .catch(() => undefined);
  if (!me) {
    console.error('The key handed back by the console did not validate — try again.');
    return 1;
  }

  writeConfig({ ...readConfig(), PHONE_USE_CLOUD_URL: api, PHONE_USE_CLOUD_TOKEN: key });
  console.log(`Signed in as ${me.name ?? 'account'} → ${USER_CONFIG_PATH}`);
  console.log('Try it: phone-use create ios');
  return 0;
}

export function runLogout(): number {
  const config = readConfig();
  delete config.PHONE_USE_CLOUD_TOKEN;
  writeConfig(config);
  console.log('Signed out (key removed from config; the key itself remains valid until rotated).');
  return 0;
}

/**
 * Device authorization: ask the control plane for a short code, show it, and
 * poll until a signed-in human approves it in the console. Nothing listens on
 * a local port and no browser is required, so this works anywhere a terminal
 * does.
 */
async function runDeviceLogin(api: string): Promise<number> {
  const started = await fetch(`${api}/v1/device/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientName: `phone-use CLI (${process.platform})` }),
  })
    .then((r) => (r.ok ? (r.json() as Promise<DeviceStart>) : undefined))
    .catch(() => undefined);
  if (!started) {
    console.error(`Could not start a device login against ${api}.`);
    return 1;
  }

  console.log('');
  console.log(`  Open:  ${started.verificationUri}`);
  console.log(`  Code:  ${started.userCode}`);
  console.log('');
  console.log('Waiting for approval… (Ctrl-C to cancel)');

  const deadline = started.expiresAt;
  const interval = started.intervalMs ?? 5000;
  while (Date.now() < deadline) {
    await Bun.sleep(interval);
    const result = await fetch(`${api}/v1/device/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: started.deviceCode }),
    })
      .then((r) => r.json() as Promise<{ status: string; key?: string }>)
      .catch(() => ({ status: 'network' }) as { status: string; key?: string });

    if (result.status === 'approved' && result.key) {
      writeConfig({ ...readConfig(), PHONE_USE_CLOUD_URL: api, PHONE_USE_CLOUD_TOKEN: result.key });
      const me = await fetch(`${api}/v1/me`, { headers: { authorization: `Bearer ${result.key}` } })
        .then((r) => (r.ok ? (r.json() as Promise<{ name?: string }>) : undefined))
        .catch(() => undefined);
      console.log(`Signed in as ${me?.name ?? 'account'} → ${USER_CONFIG_PATH}`);
      return 0;
    }
    if (result.status === 'denied') {
      console.error('The request was denied in the console.');
      return 1;
    }
    if (result.status === 'not_found') {
      console.error('That login expired or was already used — run `phone-use login` again.');
      return 1;
    }
  }
  console.error('Timed out waiting for approval — run `phone-use login` again.');
  return 1;
}

type DeviceStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs?: number;
};
