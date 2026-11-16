"use client";

// Sign in / create account (Better Auth: email + password, Google).

import { useState } from "react";

export type Me = {
  name?: string;
  isAdmin: boolean;
  keyCreatedAt?: number | null;
  /** False while cloud phones are on a waitlist for this account. */
  cloudApproved?: boolean;
  waitlistUrl?: string;
};

// Android is offered only once an Android worker is deployed (see Dashboard).
const PHONES = process.env.NEXT_PUBLIC_ANDROID_CLOUD === "1" ? "a real iPhone or Android phone" : "a real iPhone";

export function AuthScreen({ api, onSignedIn }: { api: string; onSignedIn: (me: Me, signedUp: boolean) => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const path = mode === "signin" ? "/api/auth/sign-in/email" : "/api/auth/sign-up/email";
      const response = await fetch(`${api}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "signin" ? { email, password } : { email, password, name: name.trim() || email.split("@")[0] },
        ),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        throw new Error(
          body.message ??
            (mode === "signin" ? "Email or password didn’t match." : "Signup failed. Passwords need at least 8 characters."),
        );
      }
      const meResponse = await fetch(`${api}/v1/me`, { credentials: "include" });
      if (!meResponse.ok) throw new Error("Signed in, but the console couldn’t load your account. Refresh to try again.");
      onSignedIn((await meResponse.json()) as Me, mode === "signup");
    } catch (cause) {
      setError(String((cause as Error).message));
    }
    setBusy(false);
  }

  async function google() {
    setError("");
    try {
      const response = await fetch(`${api}/api/auth/sign-in/social`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: window.location.href }),
      });
      const body = (await response.json().catch(() => ({}))) as { url?: string; message?: string };
      if (!response.ok || !body.url) throw new Error(body.message ?? "Google sign-in isn’t configured yet.");
      window.location.href = body.url;
    } catch (cause) {
      setError(String((cause as Error).message));
    }
  }

  return (
    <div className="dash-auth-split">
      <aside className="dash-auth-visual" aria-hidden="true">
        <div className="dash-auth-statement">
          <h2>The mobile runtime for AI&nbsp;agents.</h2>
          <p>Boot {PHONES} in the cloud, hand it to your agent, and watch it work, live.</p>
        </div>
        <p className="dash-auth-footnote">Ready in seconds &middot; live screen &middot; works with any agent</p>
      </aside>

      <main className="dash-auth-page">
        <div className="dash-auth">
          <a className="logo dash-auth-logo" href="https://www.phoneuse.dev">
            <span className="logo-mark" aria-hidden="true">
              <i />
            </span>
            phone-use
          </a>
          <h1>{mode === "signin" ? "Welcome back." : "Create your account."}</h1>
          <p className="dash-auth-sub">
            {mode === "signin" ? "Sign in to manage your cloud phones." : "Cloud phones for your agents, ready in seconds."}
          </p>

          <button type="button" className="dash-btn-google" onClick={google}>
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62Z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
              <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
            </svg>
            Continue with Google
          </button>

          <div className="dash-auth-or" role="separator">
            <span>or</span>
          </div>

          {mode === "signup" && (
            <>
              <label className="dash-label" htmlFor="dash-name">
                Name
              </label>
              <input id="dash-name" className="dash-input" placeholder="Acme QA" value={name} onChange={(event) => setName(event.target.value)} />
            </>
          )}
          <label className="dash-label" htmlFor="dash-email">
            Email
          </label>
          <input
            id="dash-email"
            className="dash-input"
            type="email"
            placeholder="you@company.com"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label className="dash-label" htmlFor="dash-password">
            Password
          </label>
          <input
            id="dash-password"
            className="dash-input"
            type="password"
            placeholder={mode === "signup" ? "8+ characters" : "••••••••"}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && !busy && email.includes("@") && password.length >= 8 && submit()}
          />
          <button
            type="button"
            className="dash-btn dash-btn-block"
            onClick={submit}
            disabled={busy || !email.includes("@") || password.length < 8}
          >
            {busy ? "One moment…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
          {error && (
            <p className="dash-error" role="alert">
              {error}
            </p>
          )}

          <p className="dash-auth-switch">
            {mode === "signin" ? "New here?" : "Already have an account?"}{" "}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError("");
              }}
            >
              {mode === "signin" ? "Create an account" : "Sign in"}
            </button>
          </p>
          <p className="dash-auth-legal">
            By continuing you agree to the <a href="https://www.phoneuse.dev/terms">Terms</a> and{" "}
            <a href="https://www.phoneuse.dev/privacy">Privacy Policy</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
