import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { android, createCloudSandboxBackend, createDeviceHandle, type Device, ios } from '@phone-use/sdk';
import { runExitCode } from './verification.ts';
import { runWorkflow, type WorkflowOptions, workflowSchema } from './workflow.ts';

const exec = promisify(execFile);
export const WORKFLOW_HELP = `phone-use run <workflow.json> [--device <udid|connect|launch|android|sandbox>] [--platform ios|android] [--output <directory>] [--yes] [--json]

Execute a validated, ordered mobile flow without a model API key. Each run saves
its input, result, screen evidence and trace in a unique directory.
--yes approves confirmation requests; observe-mode restrictions still apply.
Exit: 0 verified, 1 failed/invalid, 4 unverified, 130 stopped.
Screen expectations prove UI text only; use SDK verifiers for app/server state.`;

export async function runWorkflowCli(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(WORKFLOW_HELP);
    return 0;
  }
  const asJson = argv.includes('--json');
  let device: Device | undefined;
  let owned = false;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Interrupted by caller'));
  try {
    const values: Record<string, string> = {};
    let file: string | undefined;
    let yes = false;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === '--json') continue;
      if (arg === '--yes') {
        yes = true;
        continue;
      }
      if (['--device', '--platform', '--output'].includes(arg)) {
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
        values[arg] = value;
      } else if (arg.startsWith('-') || file) throw new Error(`Unexpected argument ${arg}`);
      else file = arg;
    }
    if (!file) throw new Error(WORKFLOW_HELP);
    const workflow = workflowSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    // Validate tool names and arguments before any device lifecycle operation.
    const { validateWorkflow } = await import('./workflow.ts');
    validateWorkflow(workflow);
    const spec =
      values['--device'] ??
      process.env.PHONE_USE_DEVICE ??
      (process.env.PHONE_USE_SANDBOX_URL ? 'sandbox' : 'connect');
    const platform = values['--platform'];
    if (platform && platform !== 'ios' && platform !== 'android')
      throw new Error('--platform must be ios or android');
    let installApp: WorkflowOptions['installApp'];
    if (spec === 'sandbox') {
      if (!platform)
        throw new Error(
          'Remote runs require --platform ios|android so evidence identifies the target correctly',
        );
      const backend = createCloudSandboxBackend();
      const endpoint = process.env.PHONE_USE_SANDBOX_URL ?? '';
      const id = `endpoint-${createHash('sha256').update(endpoint).digest('hex').slice(0, 16)}`;
      device = createDeviceHandle({
        id,
        platform: platform as 'ios' | 'android',
        backend,
        createdByUs: false,
        idleTimeoutMs: false,
        doClose: async () => {},
      });
      installApp = async (path) => {
        let directory: string | undefined;
        try {
          let artifact = path;
          if (path.endsWith('.app')) {
            directory = await mkdtemp(join(tmpdir(), 'phone-install-'));
            artifact = join(directory, 'app.zip');
            await exec('ditto', ['-c', '-k', '--keepParent', path, artifact], { timeout: 120_000 });
          }
          await backend.installAppStream(Bun.file(artifact));
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      };
    } else if (spec === 'android' || platform === 'android') {
      device = await android.connect(spec === 'android' ? process.env.PHONE_USE_ANDROID_SERIAL : spec, {
        idleTimeoutMs: false,
      });
      const serial = device.id;
      installApp = async (path) => {
        await exec(process.env.PHONE_USE_ADB_BIN ?? 'adb', ['-s', serial, 'install', '-r', path], {
          timeout: 120_000,
        });
      };
    } else {
      if (spec === 'mirror')
        throw new Error(
          'Declarative runs require a pinned simulator, Android device, or sandbox; use mirror verbs directly',
        );
      const selected = process.env.DEVELOPER_DIR ?? (await exec('xcode-select', ['-p'])).stdout.trim();
      if (!selected || selected.includes('CommandLineTools'))
        throw new Error('Full Xcode is not selected. Run phone-use doctor for repair instructions.');
      let udid = spec;
      if (spec === 'connect') {
        const { stdout } = await exec('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
        const devices = Object.values(
          (JSON.parse(stdout) as { devices: Record<string, { udid: string; state: string }[]> }).devices,
        )
          .flat()
          .filter((d) => d.state === 'Booted');
        if (devices.length !== 1)
          throw new Error(
            `Found ${devices.length} booted simulators. Use --device <udid> or --device launch.`,
          );
        udid = devices[0]!.udid;
      }
      device =
        spec === 'launch'
          ? await ios.launch({ idleTimeoutMs: false })
          : await ios.connect(udid, { idleTimeoutMs: false });
      owned = spec === 'launch';
      const id = device.id;
      installApp = async (path) => {
        await exec('xcrun', ['simctl', 'install', id, path], { timeout: 120_000 });
      };
    }
    if (workflow.install) workflow.install = resolve(dirname(resolve(file)), workflow.install);
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    const result = await runWorkflow(workflow, {
      device,
      installApp,
      outputDir: resolve(values['--output'] ?? join(homedir(), '.phone-use', 'runs')),
      mode:
        process.env.PHONE_USE_MODE === 'observe'
          ? 'observe'
          : process.env.PHONE_USE_MODE === 'auto'
            ? 'auto'
            : 'default',
      onConfirm: () => yes,
      signal: controller.signal,
    });
    console.log(
      asJson
        ? JSON.stringify(result, null, 2)
        : `[${result.status}] ${result.name}\n${result.failure?.detail ?? result.checks.map((c) => c.detail).join('\n')}\nEvidence: ${result.artifacts.result}`,
    );
    return runExitCode(result.status);
  } catch (error) {
    console.log(
      asJson ? JSON.stringify({ status: 'failed', error: String(error) }) : `ERROR: ${String(error)}`,
    );
    return 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    if (owned) await device?.close();
  }
}
