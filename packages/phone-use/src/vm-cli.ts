// `phone-use vm …` — rent and prepare the Macs that host simulators.
// Talks to the Scaleway Apple-silicon API directly (SCW_* env / .env). This is
// the operator-side counterpart of `phone-use create` (which makes sandboxes).
// Preparing the host once it is delivered (Xcode, Bun, the worker service) is
// done with the operator's own scripts, which are not part of this repository:
// `vm bootstrap` runs PHONE_USE_VM_BOOTSTRAP_SCRIPT when it is set.

const ZONE = process.env.SCW_ZONE ?? 'fr-par-1';
const API = `https://api.scaleway.com/apple-silicon/v1alpha1/zones/${ZONE}`;

type Server = {
  id: string;
  name: string;
  type: string;
  status: string;
  ip: string;
  created_at?: string;
};

function auth(): { token: string; project: string } {
  const token = process.env.SCW_SECRET_KEY;
  const project = process.env.SCW_DEFAULT_PROJECT_ID;
  if (!token || !project) {
    console.error('SCW_SECRET_KEY and SCW_DEFAULT_PROJECT_ID are required (set them in .env)');
    process.exit(1);
  }
  return { token, project };
}

async function scw<T>(path: string, init?: RequestInit): Promise<T> {
  const { token } = auth();
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'X-Auth-Token': token, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `Scaleway API ${response.status}`);
  return body;
}

export async function runVmCli(args: string[]): Promise<number> {
  const [command = 'help', ...rest] = args;
  try {
    switch (command) {
      case 'list': {
        const { servers } = await scw<{ servers: Server[] }>('/servers');
        if (!servers.length) {
          console.log('No Macs rented.');
          return 0;
        }
        console.log('ID                                    TYPE    STATUS    IP');
        for (const s of servers) {
          console.log(`${s.id}  ${s.type.padEnd(7)} ${s.status.padEnd(9)} ${s.ip}`);
        }
        return 0;
      }
      case 'types': {
        const { server_types } = await scw<{
          server_types: Array<{ name: string; stock: string; memory: { capacity: number } }>;
        }>('/server-types');
        for (const t of server_types) {
          console.log(`${t.name.padEnd(10)} ${String(t.memory.capacity / 1e9).padStart(3)}GB  ${t.stock}`);
        }
        return 0;
      }
      case 'create': {
        const type = rest[0];
        if (!type) {
          console.error('usage: phone-use vm create <M4-M|M4-XL|M2-L|…> [--name <name>]');
          return 1;
        }
        const ni = rest.indexOf('--name');
        const name = ni !== -1 ? rest[ni + 1] : `phone-use-worker-${Date.now().toString(36)}`;
        const { project } = auth();
        const server = await scw<Server>('/servers', {
          method: 'POST',
          body: JSON.stringify({ name, project_id: project, type }),
        });
        console.log(`Created ${server.id} (${server.type}) — status: ${server.status}, ip: ${server.ip}`);
        console.log('Note: Apple-silicon rentals bill a 24h minimum. Delivery can take up to ~40min.');
        console.log(`Next: phone-use vm bootstrap ${server.id}`);
        return 0;
      }
      case 'bootstrap': {
        const id = rest[0];
        if (!id) {
          console.error('usage: phone-use vm bootstrap <server-id>');
          return 1;
        }
        let server = await scw<Server>(`/servers/${id}`);
        while (server.status !== 'ready') {
          console.log(`  waiting for delivery… (${server.status})`);
          await Bun.sleep(60_000);
          server = await scw<Server>(`/servers/${id}`);
        }
        const script = process.env.PHONE_USE_VM_BOOTSTRAP_SCRIPT;
        if (!script) {
          console.log(`Server ready at ${server.ip}.`);
          console.log(
            'Set PHONE_USE_VM_BOOTSTRAP_SCRIPT to a script that prepares the host (it gets the IP as its argument) to run it from here.',
          );
          return 0;
        }
        console.log(`Server ready at ${server.ip}; running ${script}`);
        const proc = Bun.spawn(['bash', script, server.ip], {
          stdout: 'inherit',
          stderr: 'inherit',
        });
        return await proc.exited;
      }
      case 'delete': {
        const id = rest[0];
        if (!id || !rest.includes('--yes')) {
          console.error(
            'usage: phone-use vm delete <server-id> --yes   (destroys the Mac and everything on it)',
          );
          return 1;
        }
        await scw(`/servers/${id}`, { method: 'DELETE' });
        console.log(`Deleted ${id}. Billing stops (24h minimum still applies).`);
        return 0;
      }
      default:
        console.log(`phone-use vm — rent and prepare simulator hosts (operator tool)

  types                    show Mac types and live stock
  list                     rented Macs
  create <TYPE>            rent a Mac (24h minimum, ~40min delivery)
  bootstrap <id>           wait for delivery, then install limits/bun/repo/runtime
  delete <id> --yes        return the Mac

Credentials: SCW_SECRET_KEY + SCW_DEFAULT_PROJECT_ID (from .env or the environment).`);
        return command === 'help' ? 0 : 1;
    }
  } catch (error) {
    console.error(`vm ${command} failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}
