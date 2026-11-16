import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProvisionedResource, SandboxCheckpoint } from './types.ts';

export type PersistedSandbox = {
  sandboxId: string;
  token: string;
  resource: ProvisionedResource;
  /** Saved device states (absent on older state files — treat as []). */
  checkpoints?: SandboxCheckpoint[] | undefined;
};

export class WorkerStateStore {
  constructor(readonly path: string) {}

  async load(): Promise<PersistedSandbox[]> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as PersistedSandbox[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Serialises saves. Two concurrent writers shared one temp path and one
   *  would rename a file the other had already consumed — invisible until a
   *  fleet was provisioned at once, then ENOENT on state.json.tmp. */
  private writes: Promise<void> = Promise.resolve();
  private counter = 0;

  async save(sandboxes: PersistedSandbox[]): Promise<void> {
    const snapshot = [...sandboxes];
    this.writes = this.writes.then(() => this.writeAtomic(snapshot)).catch(() => undefined);
    return this.writes;
  }

  private async writeAtomic(sandboxes: PersistedSandbox[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Unique per write as well as serialised: belt and braces, since a crashed
    // process can leave a stale temp behind that a fixed name would inherit.
    const temporary = `${this.path}.${process.pid}.${this.counter++}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(sandboxes, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
