import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Per-phone traffic capture (Stage 2 of the failure artifact: checkpoint =
// world state, flight trace = actions, THIS = the network the apps spoke).
//
// The worker runs one mitmdump per host with capture/mitm_addon.py; the addon
// attributes each flow to a simulator by udid and tags it with the sandbox id
// from devices.json — a map THIS class owns and rewrites on every provision,
// restore, and delete. Attribution therefore survives checkpoint restores
// (which change the udid) with no proxy restart.
//
// OPT-IN PER HOST (PHONE_USE_CAPTURE=1) because capture only sees traffic the
// host actually routes through the proxy. Simulators follow macOS's system
// proxy, so a capture host is configured once by the operator:
//   networksetup -setwebproxy       <service> 127.0.0.1 <port>
//   networksetup -setsecurewebproxy <service> 127.0.0.1 <port>
// and each phone additionally trusts the mitm CA — the provider installs it
// into every provisioned simulator when PHONE_USE_CAPTURE_CA is set (default:
// ~/.mitmproxy/mitmproxy-ca-cert.pem, created by mitmdump on first run).
// Apps that pin certificates bypass capture; their flows appear as errors.
// ---------------------------------------------------------------------------

export type CapturedFlow = {
  ts: string;
  sandboxId: string | null;
  udid: string | null;
  method: string;
  host: string;
  path: string;
  status: number | null;
  reqBytes: number;
  resBytes: number;
  contentType: string | null;
  durMs: number | null;
  error: string | null;
};

export type CaptureManagerOptions = {
  dataDirectory: string;
  /** mitmdump listen port (default 9040). */
  port?: number | undefined;
  /** Capture request/response bodies (capped + base64). Default false. */
  bodies?: boolean | undefined;
  /** Path to the mitmdump binary; default resolves from PATH. */
  mitmdumpBin?: string | undefined;
  /** Addon path override (tests). */
  addonPath?: string | undefined;
};

/** Resolve the CA the provider should install into phones, or undefined. */
export function captureCaPath(): string | undefined {
  const explicit = process.env.PHONE_USE_CAPTURE_CA;
  if (explicit) return explicit;
  const mitm = join(homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem');
  return existsSync(mitm) ? mitm : undefined;
}

export class CaptureManager {
  readonly captureDir: string;
  readonly port: number;
  private readonly mapPath: string;
  private readonly flowsPath: string;
  private readonly devices = new Map<string, string>(); // udid -> sandboxId
  private child: ReturnType<typeof Bun.spawn> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly opts: CaptureManagerOptions) {
    this.captureDir = join(opts.dataDirectory, 'capture');
    this.port = opts.port ?? Number(process.env.PHONE_USE_CAPTURE_PORT ?? 9040);
    this.mapPath = join(this.captureDir, 'devices.json');
    this.flowsPath = join(this.captureDir, 'flows.jsonl');
  }

  /**
   * Launch mitmdump with the attribution addon. Fails LOUDLY when the binary
   * is missing — an operator who enabled capture must not silently run blind.
   */
  async start(): Promise<void> {
    await mkdir(this.captureDir, { recursive: true, mode: 0o700 });
    await this.persistMap();
    const bin = this.opts.mitmdumpBin ?? process.env.PHONE_USE_MITMDUMP ?? Bun.which('mitmdump');
    if (!bin) {
      throw new Error(
        'PHONE_USE_CAPTURE=1 but mitmdump was not found — install mitmproxy (brew install mitmproxy) or set PHONE_USE_MITMDUMP',
      );
    }
    const addon = this.opts.addonPath ?? join(import.meta.dir, '..', 'capture', 'mitm_addon.py');
    this.child = Bun.spawn([bin, '--listen-port', String(this.port), '-q', '-s', addon], {
      env: {
        ...Bun.env,
        PHONE_USE_CAPTURE_DIR: this.captureDir,
        ...(this.opts.bodies ? { PHONE_USE_CAPTURE_BODIES: '1' } : {}),
      },
      stdout: 'ignore',
      stderr: 'inherit',
    });
    void this.child.exited.then((code) => {
      // A dead proxy means phones lose network on a proxy-configured host —
      // scream, don't whisper. Supervision (launchd) restarts the worker.
      if (code !== 0) console.error(`capture: mitmdump exited with ${code}`);
    });
  }

  stop(): void {
    this.child?.kill();
  }

  /** Record which sandbox owns a udid. Called on provision/adopt/restore. */
  async setDevice(sandboxId: string, udid: string): Promise<void> {
    // One sandbox, one live udid: drop any previous mapping for this sandbox
    // (restore swaps udids and the stale one must not attribute new flows).
    for (const [existingUdid, owner] of this.devices) {
      if (owner === sandboxId) this.devices.delete(existingUdid);
    }
    this.devices.set(udid, sandboxId);
    await this.persistMap();
  }

  async removeDevice(sandboxId: string): Promise<void> {
    for (const [udid, owner] of this.devices) {
      if (owner === sandboxId) this.devices.delete(udid);
    }
    await this.persistMap();
  }

  /** The tail of a sandbox's captured flows, newest last. */
  async flowsFor(sandboxId: string, limit = 500): Promise<CapturedFlow[]> {
    let raw: string;
    try {
      raw = await readFile(this.flowsPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const flows: CapturedFlow[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as CapturedFlow;
        if (parsed.sandboxId === sandboxId) flows.push(parsed);
      } catch {
        /* torn tail line mid-write — skip */
      }
    }
    return flows.slice(-limit);
  }

  /** Atomic + serialised, same discipline as WorkerStateStore: the addon may
   * read at any moment and must never see a half-written map. */
  private persistMap(): Promise<void> {
    const snapshot = Object.fromEntries(this.devices);
    this.writes = this.writes
      .then(async () => {
        // The map must be writable even when the proxy never started (host
        // without mitmdump, tests): attribution state and proxy lifetime are
        // deliberately independent.
        await mkdir(this.captureDir, { recursive: true, mode: 0o700 });
        const temporary = `${this.mapPath}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
        await rename(temporary, this.mapPath);
      })
      .catch((error) => console.error('capture: failed to persist device map:', error));
    return this.writes;
  }
}
