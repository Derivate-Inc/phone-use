import { Database } from 'bun:sqlite';
import { betterAuth } from 'better-auth';

// Human auth (console): Better Auth with email+password, sessions in the same
// SQLite file as everything else. Agents and the CLI never touch this — they
// keep tenant bearer keys; the control plane accepts either.
export type Auth = ReturnType<typeof createAuth>;

export function createAuth(options: {
  databasePath: string;
  baseURL?: string | undefined;
  secret?: string | undefined;
  trustedOrigins?: string[] | undefined;
}) {
  // Better Auth opens its own connection; without busy_timeout its writes race
  // the reaper/worker-poll write locks and surface as 500s on signup/login.
  const authDb = new Database(options.databasePath);
  authDb.exec('PRAGMA busy_timeout = 5000');
  authDb.exec('PRAGMA synchronous = NORMAL');
  return betterAuth({
    database: authDb,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.secret ? { secret: options.secret } : {}),
    trustedOrigins: options.trustedOrigins ?? [],
    emailAndPassword: { enabled: true },
    // Launch telemetry that matters: every real signup mails the operator.
    databaseHooks: {
      user: {
        create: {
          after: async (user: { email: string; name?: string }) => {
            const to = process.env.PHONE_USE_ALERT_EMAIL;
            if (!process.env.RESEND_API_KEY || !to) return;
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                from: process.env.RESEND_FROM ?? 'phone-use <auth@phoneuse.dev>',
                to,
                subject: `new signup: ${user.email}`,
                text: `${user.name || 'Someone'} <${user.email}> just created a phone-use account.`,
              }),
            }).catch((e) => console.error('signup alert failed:', e));
          },
        },
      },
    },
    // Same email via Google links to the existing account instead of erroring
    // with account_not_linked — safe because Google verifies email ownership.
    account: { accountLinking: { enabled: true, trustedProviders: ['google'] } },
    // Verification emails via Resend (no-op without a key). Verified emails are
    // what make provider auto-linking possible for password-first signups.
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        if (!process.env.RESEND_API_KEY) return;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: process.env.RESEND_FROM ?? 'phone-use <auth@phoneuse.dev>',
            to: user.email,
            subject: 'Verify your email',
            html: `<div style="font-family:system-ui;max-width:420px;margin:0 auto;padding:24px">
              <h2 style="letter-spacing:-0.02em">Verify your email</h2>
              <p style="color:#666670">Confirm this address to finish setting up your phone-use account.</p>
              <a href="${url}" style="display:inline-block;background:#101014;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Verify email</a>
              <p style="color:#9c9ca6;font-size:13px;margin-top:18px">If you didn’t create this account, ignore this email.</p>
            </div>`,
          }),
        }).then((res) => {
          if (!res.ok) {
            void res.text().then((t) => console.error('verification email failed:', res.status, t, 'to', user.email));
          }
        }).catch((e) => console.error('verification email failed:', e, 'to', user.email));
      },
    },
    // Google sign-in activates when credentials exist (console → APIs & Services
    // → OAuth client; redirect URI: {BETTER_AUTH_URL}/api/auth/callback/google).
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          socialProviders: {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
          },
        }
      : {}),
    // Built-in rate limiting for auth endpoints (sign-in/up brute force).
    rateLimit: { enabled: true, window: 60, max: 20 },
    // Cookies are host-only on the canonical console origin — the console
    // reaches this server through its own-origin proxy, so cross-subdomain
    // cookies are unnecessary surface. (codex #5)
  });
}

/** Create Better Auth's tables if missing (runs at startup; idempotent). */
export async function migrateAuth(auth: Auth): Promise<void> {
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
