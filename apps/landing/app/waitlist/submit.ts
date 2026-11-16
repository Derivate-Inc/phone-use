// The waitlist form's one request, kept free of React so it can be tested.
//
// It posts to /v1/waitlist on this origin; next.config.ts forwards /v1/* to
// the control plane, which saves the entry. Same origin means no CORS and no
// second place that knows the API's address.

export type WaitlistValues = { email: string; useCase: string };

export type WaitlistResult = { ok: true } | { ok: false; message: string };

const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export async function submitWaitlist(
  values: WaitlistValues,
  fetchImpl: typeof fetch = fetch,
): Promise<WaitlistResult> {
  const email = values.email.trim();
  if (!looksLikeEmail(email)) return { ok: false, message: "Enter a valid email address." };
  let response: Response;
  try {
    response = await fetchImpl("/v1/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, useCase: values.useCase.trim() }),
    });
  } catch {
    return { ok: false, message: "Could not reach the server. Check your connection and try again." };
  }
  const data: unknown = await response.json().catch(() => undefined);
  const body = data !== null && typeof data === "object" ? data as { ok?: unknown; error?: unknown } : undefined;
  // A proxy or a misconfigured rewrite can return a 200 HTML page. Confirm
  // only after the control plane has explicitly acknowledged saving the entry.
  if (response.ok && body?.ok === true) return { ok: true };
  if (response.status === 429) {
    return { ok: false, message: "Too many requests from here. Try again in a minute." };
  }
  // The server's 400 messages are written for the person filling in the form.
  if (response.status === 400 && typeof body?.error === "string") return { ok: false, message: body.error };
  return { ok: false, message: "Something went wrong on our side. Try again in a minute." };
}
