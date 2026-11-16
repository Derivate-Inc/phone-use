import { readFile } from 'node:fs/promises';
import { type PrivacyService, type SimulatorTools, simulator, soleBootedSimulator } from '@phone-use/sdk';
import { acquireDevice, callerIdentity, DeviceLeaseError } from './device-lease.ts';

// ---------------------------------------------------------------------------
// `phone-use sim …` — simulator controls a coding agent uses to check its own
// change: app logs, a screen recording, permissions granted up front, push,
// clipboard, location, dark mode, a clean status bar, install/uninstall.
// Host-side simctl only; no runner needed. The simulator is PHONE_USE_DEVICE
// (a udid) or the one booted simulator — never a guess among several.
// ---------------------------------------------------------------------------

const UDID_RE = /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

const USAGE = `phone-use sim <command> — simulator controls (simctl; no runner needed)

  logs start [bundle.id] [--path file]   stream app logs (or all logs) to a file
  logs stop | logs path                  stop streaming / print the log file
  record start [file.mp4] | record stop  screen recording (H.264)
  permission grant|revoke|reset <service> [bundle.id]
                                         services: all calendar contacts location location-always
                                         photos photos-add media-library microphone motion reminders siri
  appearance light|dark
  push <bundle.id> <payload.json>        deliver an APNs payload
  clipboard [text]                       read the clipboard, or write text to it
  location <lat> <lon> | location clear
  statusbar clean|reset                  9:41, full battery and signal (for screenshots)
  install <App.app> | uninstall <bundle.id> | terminate <bundle.id>

The simulator is PHONE_USE_DEVICE=<udid>, or the one booted simulator.`;

async function target(): Promise<SimulatorTools> {
  const spec = process.env.PHONE_USE_DEVICE;
  return simulator(spec && UDID_RE.test(spec) ? spec : await soleBootedSimulator());
}

/** Run `phone-use sim <args>`; returns the process exit code. */
export async function runSimCli(args: string[], log: (line: string) => void = console.log): Promise<number> {
  const [command, sub, ...rest] = args;
  if (!command || command === '--help' || command === 'help') {
    log(USAGE);
    return command ? 0 : 1;
  }
  const sim = await target();
  // Commands that change the simulator or its apps need the device lease:
  // another agent must not uninstall or reconfigure an app an agent is using.
  const changes =
    [
      'install',
      'uninstall',
      'terminate',
      'permission',
      'push',
      'location',
      'appearance',
      'statusbar',
    ].includes(command) ||
    (command === 'clipboard' && sub !== undefined);
  if (changes) {
    try {
      acquireDevice(sim.udid, callerIdentity('cli'), `Simulator ${sim.udid}`);
    } catch (error) {
      if (!(error instanceof DeviceLeaseError)) throw error;
      log(`ERROR: ${error.message}`);
      return 1;
    }
  }
  switch (command) {
    case 'logs': {
      if (sub === 'start') {
        const pi = rest.indexOf('--path');
        const path = pi === -1 ? undefined : rest[pi + 1];
        const bundleId = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--path');
        const capture = await sim.logs.start({ bundleId, path });
        log(`Streaming ${bundleId ? `${bundleId} logs` : 'all logs'} to ${capture.path}`);
        return 0;
      }
      if (sub === 'stop') {
        const capture = await sim.logs.stop();
        log(capture ? `Stopped. Log: ${capture.path}` : 'No log stream was running.');
        return 0;
      }
      if (sub === 'path') {
        const capture = sim.logs.current();
        log(capture ? capture.path : 'No log stream is running.');
        return capture ? 0 : 1;
      }
      break;
    }
    case 'record': {
      if (sub === 'start') {
        const capture = await sim.record.start(rest[0]);
        log(`Recording to ${capture.path} — stop with: phone-use sim record stop`);
        return 0;
      }
      if (sub === 'stop') {
        const capture = await sim.record.stop();
        log(capture ? `Saved ${capture.path}` : 'No recording was running.');
        return 0;
      }
      break;
    }
    case 'permission': {
      const service = rest[0] as PrivacyService | undefined;
      if ((sub === 'grant' || sub === 'revoke' || sub === 'reset') && service) {
        await sim.permission(sub, service, rest[1]);
        log(`${sub} ${service}${rest[1] ? ` for ${rest[1]}` : ''}`);
        return 0;
      }
      break;
    }
    case 'appearance': {
      if (sub === 'light' || sub === 'dark') {
        await sim.appearance(sub);
        log(`Appearance: ${sub}`);
        return 0;
      }
      break;
    }
    case 'push': {
      if (sub && rest[0]) {
        await sim.push(sub, JSON.parse(await readFile(rest[0], 'utf8')) as Record<string, unknown>);
        log(`Pushed ${rest[0]} to ${sub}`);
        return 0;
      }
      break;
    }
    case 'clipboard': {
      if (sub === undefined) {
        log(await sim.clipboard.read());
        return 0;
      }
      await sim.clipboard.write([sub, ...rest].join(' '));
      log('Clipboard set.');
      return 0;
    }
    case 'location': {
      if (sub === 'clear') {
        await sim.location.clear();
        log('Location cleared.');
        return 0;
      }
      const lat = Number(sub);
      const lon = Number(rest[0]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        await sim.location.set(lat, lon);
        log(`Location: ${lat}, ${lon}`);
        return 0;
      }
      break;
    }
    case 'statusbar': {
      if (sub === 'clean' || sub === 'reset') {
        await (sub === 'clean' ? sim.statusBar.clean() : sim.statusBar.reset());
        log(`Status bar ${sub === 'clean' ? 'cleaned (9:41)' : 'reset'}.`);
        return 0;
      }
      break;
    }
    case 'install': {
      if (sub) {
        await sim.install(sub);
        log(`Installed ${sub}`);
        return 0;
      }
      break;
    }
    case 'uninstall':
    case 'terminate': {
      if (sub) {
        await (command === 'uninstall' ? sim.uninstall(sub) : sim.terminate(sub));
        log(`${command === 'uninstall' ? 'Uninstalled' : 'Terminated'} ${sub}`);
        return 0;
      }
      break;
    }
    default:
      break;
  }
  log(USAGE);
  return 1;
}
