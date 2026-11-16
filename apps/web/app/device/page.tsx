"use client";

// Device-authorization approval screen (RFC 8628). A CLI with no browser shows
// the user a short code; this is where a signed-in human approves it.

import { useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_PHONE_USE_API ?? "";

type Pending = { clientName: string | null; expiresAt: number };
type Phase = "checking" | "signed-out" | "prompt" | "approved" | "denied" | "unknown" | "error";

export default function DevicePage() {
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>("checking");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("code") ?? "";
    setCode(fromUrl.toUpperCase());
    void fetch(`${API}/v1/me`, { credentials: "include" }).then((r) => {
      setPhase(r.ok ? "prompt" : "signed-out");
    });
  }, []);

  const lookup = useCallback(async (value: string) => {
    if (!/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(value)) return;
    const res = await fetch(`${API}/v1/device/pending?code=${encodeURIComponent(value)}`, {
      credentials: "include",
    });
    if (res.ok) {
      setPending((await res.json()) as Pending);
      setError("");
    } else {
      setPending(null);
      setError("That code is unknown or has expired.");
    }
  }, []);

  useEffect(() => {
    if (phase === "prompt" && code) void lookup(code);
  }, [phase, code, lookup]);

  async function decide(action: "approve" | "deny") {
    setBusy(true);
    setError("");
    const res = await fetch(`${API}/v1/device/${action}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setBusy(false);
    if (res.ok) setPhase(action === "approve" ? "approved" : "denied");
    else setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Failed.");
  }

  if (phase === "checking") return <main className="dash-auth-page" aria-hidden />;

  return (
    <main className="dash-auth-page">
      <div className="dash-auth">
        <a className="logo dash-auth-logo" href="https://www.phoneuse.dev">
          <span className="logo-mark" aria-hidden>
            <i />
          </span>
          phone-use
        </a>

        {phase === "signed-out" && (
          <>
            <h1>Sign in to continue</h1>
            <p className="dash-auth-sub">
              A terminal is asking to connect. Sign in, then come back to this page to approve it.
            </p>
            <a className="dash-btn dash-btn-block" href={`/?next=${encodeURIComponent("/device")}`}>
              Sign in
            </a>
          </>
        )}

        {phase === "prompt" && (
          <>
            <h1>Connect a terminal?</h1>
            <p className="dash-auth-sub">
              {pending?.clientName ?? "A command line client"} is asking for an API key. Approving
              mints a fresh key — replacing any existing one — and hands it to that terminal.
            </p>
            <label className="dash-label" htmlFor="device-code">
              Code shown in your terminal
            </label>
            <input
              id="device-code"
              className="dash-input dash-mono"
              value={code}
              placeholder="ABCD-2345"
              autoComplete="off"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onBlur={() => void lookup(code)}
            />
            {error && (
              <p className="dash-error" role="alert">
                {error}
              </p>
            )}
            <button
              type="button"
              className="dash-btn dash-btn-block"
              disabled={busy || !pending}
              onClick={() => void decide("approve")}
            >
              {busy ? "Approving…" : "Approve"}
            </button>
            <p className="dash-auth-switch">
              Didn&apos;t start this?{" "}
              <button type="button" onClick={() => void decide("deny")}>
                Deny
              </button>
            </p>
          </>
        )}

        {phase === "approved" && (
          <>
            <h1>Terminal connected.</h1>
            <p className="dash-auth-sub">
              Return to your terminal — it has the key and is ready to create phones.
            </p>
            <a className="dash-btn dash-btn-block" href="/">
              Go to the console
            </a>
          </>
        )}

        {phase === "denied" && (
          <>
            <h1>Request denied.</h1>
            <p className="dash-auth-sub">No key was issued. You can close this tab.</p>
          </>
        )}
      </div>
    </main>
  );
}
