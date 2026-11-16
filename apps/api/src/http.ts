export class CloudApiError extends Error {
  readonly status: number;
  readonly code?: string | undefined;
  /** Sent with the `cloud_waitlist` refusal: where to join the waitlist. */
  readonly waitlistUrl?: string | undefined;

  constructor(message: string, status: number, code?: string, waitlistUrl?: string) {
    super(message);
    this.name = 'CloudApiError';
    this.status = status;
    this.code = code;
    this.waitlistUrl = waitlistUrl;
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

export async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string | undefined;
    message?: string | undefined;
    code?: string | undefined;
    waitlistUrl?: string | undefined;
  };
  if (!response.ok) {
    throw new CloudApiError(
      body.error ?? body.message ?? `HTTP ${response.status}`,
      response.status,
      body.code,
      typeof body.waitlistUrl === 'string' ? body.waitlistUrl : undefined,
    );
  }
  return body as T;
}

export function bearer(request: Request): string | undefined {
  const value = request.headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
}

export function trimUrl(value: string): string {
  return value.replace(/\/+$/, '');
}
