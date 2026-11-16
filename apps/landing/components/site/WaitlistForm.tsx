"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { submitWaitlist } from "@/app/waitlist/submit";

// The waitlist form: an email and what the person would use cloud phones for.
// It saves to the control plane and then replaces itself with a confirmation.
export default function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [useCase, setUseCase] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === "sending") return;
    setState("sending");
    setError("");
    const result = await submitWaitlist({ email, useCase });
    if (result.ok) {
      setState("done");
    } else {
      setError(result.message);
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <div className="waitlist-done" role="status" tabIndex={-1} ref={(node) => node?.focus()}>
        <h2>You are on the list</h2>
        <p>
          We will email <strong>{email.trim()}</strong> when there is a cloud phone for you.
        </p>
        <p>
          Until then, phone-use works on your own machine with no account.{" "}
          <Link href="/docs/quickstart">Start with the local simulator</Link>.
        </p>
      </div>
    );
  }

  return (
    <form className="waitlist-form" onSubmit={submit} noValidate>
      <div className="waitlist-field">
        <label htmlFor="waitlist-email">Email</label>
        <input
          id="waitlist-email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@company.com"
          required
          disabled={state === "sending"}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "waitlist-error" : undefined}
        />
      </div>
      <div className="waitlist-field">
        <label htmlFor="waitlist-use">What would you use cloud phones for?</label>
        <textarea
          id="waitlist-use"
          name="useCase"
          rows={4}
          maxLength={2000}
          disabled={state === "sending"}
          placeholder="For example: run my app's UI tests on every pull request."
          value={useCase}
          onChange={(event) => setUseCase(event.target.value)}
        />
      </div>
      {error && (
        <p id="waitlist-error" className="waitlist-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="site-btn" disabled={state === "sending"}>
        {state === "sending" ? "Joining…" : "Join the waitlist"}
      </button>
    </form>
  );
}
