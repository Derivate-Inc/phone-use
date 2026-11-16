/**
 * phone-use relay — lets a phone be driven from anywhere.
 *
 * The on-device runner dials OUT to this server and holds the socket open, so
 * the phone needs no inbound ports, no port-forwarding, no VPN, and no Mac. Any
 * agent that can reach the relay drives the phone by POSTing JSON-RPC at it.
 *
 *   iPhone runner ──ws──▶ relay ◀──http── agent (Hermes / CLI / MCP / anywhere)
 *
 * Run:  phone-use relay --port 8787 --token <shared-secret>
 * Then: PHONE_USE_RUNNER_URL=https://relay.example/d/<deviceId> phone-use observe
 */

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DeviceSession {
  socket: WebSocket;
  connectedAt: number;
  lastSeen: number;
  pending: Map<number, PendingCall>;
}

export interface RelayOptions {
  port?: number;
  token?: string;
  callTimeoutMs?: number;
}

export function startRelay(opts: RelayOptions = {}) {
  const port = opts.port ?? Number(process.env.PHONE_USE_RELAY_PORT ?? 8787);
  const token = opts.token ?? process.env.PHONE_USE_RELAY_TOKEN;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const devices = new Map<string, DeviceSession>();
  let nextCallId = 1;

  const authorized = (req: Request): boolean => {
    if (!token) return true;
    const header = req.headers.get('authorization') ?? '';
    return header === `Bearer ${token}`;
  };

  // The generic types ws.data for every websocket handler below; without it
  // Bun infers `undefined` and each handler needs a cast.
  const server = Bun.serve<{ deviceId: string }>({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // Device side: the runner upgrades to a WebSocket and stays connected.
      if (url.pathname === '/device') {
        const deviceId = url.searchParams.get('id');
        if (!deviceId) return new Response('missing id', { status: 400 });
        if (token && url.searchParams.get('token') !== token) {
          return new Response('unauthorized', { status: 401 });
        }
        if (srv.upgrade(req, { data: { deviceId } })) return undefined as unknown as Response;
        return new Response('upgrade failed', { status: 400 });
      }

      // Health / discovery.
      if (url.pathname === '/devices') {
        if (!authorized(req)) return new Response('unauthorized', { status: 401 });
        const list = [...devices.entries()].map(([id, d]) => ({
          id,
          connectedAt: d.connectedAt,
          lastSeen: d.lastSeen,
          inflight: d.pending.size,
        }));
        return Response.json({ devices: list });
      }

      // Agent side: POST JSON-RPC to /d/<deviceId>, relayed to that phone.
      const match = url.pathname.match(/^\/d\/([A-Za-z0-9._-]+)$/);
      if (match && req.method === 'POST') {
        if (!authorized(req)) return new Response('unauthorized', { status: 401 });
        const deviceId = match[1]!;
        const session = devices.get(deviceId);
        if (!session) {
          return Response.json(
            { error: { message: `device ${deviceId} is not connected` } },
            { status: 503 },
          );
        }
        const body = (await req.json()) as Record<string, unknown>;
        const callId = nextCallId++;
        const result = new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            session.pending.delete(callId);
            reject(new Error(`device ${deviceId} did not answer in ${callTimeoutMs}ms`));
          }, callTimeoutMs);
          session.pending.set(callId, { resolve, reject, timer });
        });
        session.socket.send(JSON.stringify({ ...body, id: callId }));
        try {
          return Response.json(await result);
        } catch (error) {
          return Response.json({ error: { message: (error as Error).message } }, { status: 504 });
        }
      }

      return new Response('phone-use relay', { status: 200 });
    },

    websocket: {
      open(ws) {
        const { deviceId } = ws.data;
        devices.get(deviceId)?.socket.close();
        devices.set(deviceId, {
          socket: ws as unknown as WebSocket,
          connectedAt: Date.now(),
          lastSeen: Date.now(),
          pending: new Map(),
        });
        console.log(`[relay] device connected: ${deviceId}`);
      },
      message(ws, raw) {
        const { deviceId } = ws.data;
        const session = devices.get(deviceId);
        if (!session) return;
        session.lastSeen = Date.now();
        let payload: { id?: number };
        try {
          payload = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (typeof payload.id !== 'number') return; // heartbeat
        const call = session.pending.get(payload.id);
        if (!call) return;
        clearTimeout(call.timer);
        session.pending.delete(payload.id);
        call.resolve(payload);
      },
      close(ws) {
        const { deviceId } = ws.data;
        const session = devices.get(deviceId);
        if (!session) return;
        for (const call of session.pending.values()) {
          clearTimeout(call.timer);
          call.reject(new Error('device disconnected'));
        }
        devices.delete(deviceId);
        console.log(`[relay] device disconnected: ${deviceId}`);
      },
    },
  });

  console.log(`[relay] listening on :${server.port}`);
  console.log(
    `[relay] device URL : ws://<host>:${server.port}/device?id=<deviceId>${token ? '&token=…' : ''}`,
  );
  console.log(`[relay] agent  URL : http://<host>:${server.port}/d/<deviceId>`);
  return server;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const tokenArg = args.indexOf('--token');
  // Spread-when-present: exactOptionalPropertyTypes rejects an explicit
  // `undefined` for an optional property.
  const port = portArg >= 0 ? Number(args[portArg + 1]) : undefined;
  const token = tokenArg >= 0 ? args[tokenArg + 1] : undefined;
  startRelay({
    ...(port !== undefined ? { port } : {}),
    ...(token !== undefined ? { token } : {}),
  });
}
