"use client";

import { useEffect, useState } from "react";
import LiveView from "./LiveView";

const API = process.env.NEXT_PUBLIC_PHONE_USE_API ?? "";
type Phone = {
  id: string;
  platform: string;
  status: string;
  expiresAt: string;
  connection?: { endpoint: string; token: string };
};

export default function PhoneViewer({ id }: { id: string }) {
  const [phone, setPhone] = useState<Phone | null>(null);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const refresh = async () => {
      let again = true;
      try {
        const response = await fetch(`${API}/v1/sandboxes/${encodeURIComponent(id)}`, {
          credentials: "include",
          cache: "no-store",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        });
        if (!alive) return;
        if (response.status === 401) {
          setSignedOut(true);
          setPhone(null);
          again = false;
          return;
        }
        if (!response.ok) {
          setPhone(null);
          throw new Error(
            response.status === 404
              ? "This phone is unavailable or belongs to another account."
              : "Cannot reach the phone. Retrying…",
          );
        }
        const next = (await response.json()) as Phone;
        if (!alive) return;
        setPhone(next);
        setError("");
        setSignedOut(false);
        again = ["queued", "preparing", "running"].includes(next.status);
      } catch (cause) {
        if (alive) {
          setPhone(null);
          setError(cause instanceof Error ? cause.message : "Cannot reach the phone.");
        }
      } finally {
        if (alive && again) timer = setTimeout(refresh, 5000);
      }
    };
    void refresh();
    return () => {
      alive = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [id]);
  return (
    <main className="phone-viewer">
      <header className="phone-viewer-bar">
        <a className="dash-ghost" href="/">
          ← Console
        </a>
        <h1>
          {phone?.platform === "android" ? "Android" : "Phone"} <span className="dash-mono">{id}</span>
        </h1>
        <button
          className="dash-btn"
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(window.location.href);
              setCopied(true);
            } catch {
              setError("Could not copy the link. Copy the address from your browser.");
            }
          }}
        >
          {copied ? "Link copied" : "Copy link"}
        </button>
      </header>
      {signedOut ? (
        <section className="phone-viewer-message">
          <h2>Sign in to watch this phone</h2>
          <p>Open the console to sign in, then return here.</p>
          <a className="dash-btn" href="/" target="_blank" rel="noopener noreferrer">
            Sign in
          </a>
          <button className="dash-btn" type="button" onClick={() => window.location.reload()}>
            I’m signed in
          </button>
        </section>
      ) : error ? (
        <p role="alert" className="phone-viewer-message">
          {error}
        </p>
      ) : phone?.status === "running" && phone.connection && Date.parse(phone.expiresAt) > Date.now() ? (
        <>
          <div className="phone-viewer-screen">
            <LiveView key={id} {...phone.connection} interactive={phone.platform === "ios"} platform={phone.platform} />
          </div>
          <p className="phone-viewer-caption">
            Watch your agent work live. Viewing keeps the phone active until its session expires.
          </p>
        </>
      ) : (
        <p className="phone-viewer-message" role="status">
          {!phone
            ? "Loading phone…"
            : phone.status === "queued" || phone.status === "preparing"
              ? `Phone is ${phone.status}. The feed will open when it is ready.`
              : "This phone is no longer available to watch."}
        </p>
      )}
    </main>
  );
}
