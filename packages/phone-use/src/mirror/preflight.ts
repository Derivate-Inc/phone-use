/**
 * Preflight for the real-iPhone backend.
 *
 * The failure mode this exists to prevent: an agent runs a verb, something
 * silently does nothing, and the model spends ten turns inventing theories
 * about the app. Every prerequisite is checked up front and every failure
 * carries the exact fix, so the answer is always "grant X" rather than "it
 * didn't work".
 *
 * Nothing here throws. Callers render the whole report, because a user missing
 * two permissions should learn both at once.
 */
import { platform, release } from 'node:os';

export type Check = {
  name: string;
  ok: boolean;
  /** What to actually do about it. Absent when ok. */
  fix?: string;
};

export type Preflight = {
  ok: boolean;
  /** True when this platform can run the mirroring backend at all. */
  supported: boolean;
  checks: Check[];
};

/** Darwin 24 is macOS 15 (Sequoia), the first release with iPhone Mirroring. */
const MIN_DARWIN_MAJOR = 24;

/**
 * Check everything the real-iPhone path needs, in the order a person would
 * fix it. Stops describing later steps once an earlier one makes them moot.
 */
export async function preflightMirror(): Promise<Preflight> {
  const checks: Check[] = [];

  if (platform() !== 'darwin') {
    return {
      ok: false,
      supported: false,
      checks: [
        {
          name: 'macOS host',
          ok: false,
          fix:
            `iPhone Mirroring is a macOS feature and this host is ${platform()}. ` +
            'To drive iOS from Linux or Windows, use the cloud backend instead: ' +
            '`phone-use create ios` then `phone-use env <id>`. ' +
            'Android has no such restriction and works locally anywhere adb runs.',
        },
      ],
    };
  }

  const darwinMajor = Number(release().split('.')[0] ?? 0);
  checks.push({
    name: 'macOS 15+ (iPhone Mirroring exists)',
    ok: darwinMajor >= MIN_DARWIN_MAJOR,
    ...(darwinMajor >= MIN_DARWIN_MAJOR
      ? {}
      : { fix: 'iPhone Mirroring needs macOS 15 (Sequoia) or newer. Update macOS.' }),
  });

  const swift = Bun.spawnSync(['which', 'swiftc'], { stdout: 'pipe', stderr: 'pipe' });
  checks.push({
    name: 'Swift toolchain (builds the native helper)',
    ok: swift.exitCode === 0,
    ...(swift.exitCode === 0 ? {} : { fix: 'Install the Xcode command line tools: xcode-select --install' }),
  });

  // Everything below needs the helper, which needs the toolchain.
  if (checks.some((c) => !c.ok)) return { ok: false, supported: true, checks };

  let report: Record<string, boolean> = {};
  try {
    const { ensureHelper } = await import('./backend.ts');
    const bin = await ensureHelper();
    const proc = Bun.spawn([bin, 'doctor'], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    report = JSON.parse(out || '{}') as Record<string, boolean>;
  } catch (error) {
    checks.push({
      name: 'native helper builds',
      ok: false,
      fix: `could not build the helper: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { ok: false, supported: true, checks };
  }

  checks.push({
    name: 'iPhone Mirroring installed',
    ok: !!report.mirroringInstalled,
    ...(report.mirroringInstalled
      ? {}
      : { fix: 'iPhone Mirroring is missing from /System/Applications — update macOS.' }),
  });
  checks.push({
    name: 'Screen Recording permission (seeing the phone)',
    ok: !!report.screenRecording,
    ...(report.screenRecording
      ? {}
      : {
          fix:
            'System Settings > Privacy & Security > Screen & System Audio Recording: enable your terminal, then restart it. ' +
            'Shortcut: open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"',
        }),
  });
  checks.push({
    name: 'Accessibility permission (taps & typing)',
    ok: !!report.accessibility,
    ...(report.accessibility
      ? {}
      : {
          fix:
            'System Settings > Privacy & Security > Accessibility: enable your terminal, then restart it. ' +
            'Shortcut: open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"',
        }),
  });
  checks.push({
    name: 'iPhone Mirroring running and connected',
    ok: !!report.mirroringRunning && !!report.windowFound,
    ...(report.mirroringRunning && report.windowFound
      ? {}
      : {
          fix:
            'Open iPhone Mirroring and connect your iPhone (same Apple Account, phone nearby and unlocked once). ' +
            'The window must stay open while the agent drives.',
        }),
  });

  // The window can be open and still not be showing the phone: a lock prompt
  // or "iPhone in Use" is a macOS view that no tap can clear. Read it, so
  // `connect` does not report a phone it cannot drive.
  if (report.mirroringRunning && report.windowFound && report.screenRecording) {
    try {
      // Run the helper directly: the backend's own wrapper calls this
      // preflight when the helper fails, which would loop.
      const { ensureHelper } = await import('./backend.ts');
      const { mirrorBlock } = await import('./blocked.ts');
      const proc = Bun.spawn([await ensureHelper(), 'ocr'], { stdout: 'pipe', stderr: 'pipe' });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const boxes = JSON.parse(out || '[]') as { text: string; confidence: number }[];
      const block = mirrorBlock(boxes.filter((b) => b.confidence >= 0.3).map((b) => b.text));
      checks.push({
        name: 'iPhone Mirroring is showing the phone',
        ok: block === null,
        ...(block ? { fix: `The window says: "${block.said}". ${block.fix}` } : {}),
      });
    } catch {
      // Reading the window failed for a reason the checks above already name.
    }
  }

  return { ok: checks.every((c) => c.ok), supported: true, checks };
}

/** Human-readable report. Used by `phone-use doctor` and by the backend when a
 *  verb is attempted before the prerequisites hold. */
export function formatPreflight(result: Preflight): string {
  const lines = result.checks.map((c) => {
    const mark = c.ok ? '  ok  ' : ' FAIL ';
    return c.ok ? `${mark} ${c.name}` : `${mark} ${c.name}\n         → ${c.fix}`;
  });
  if (!result.ok) {
    lines.push('');
    lines.push('note: these are the prerequisites known today. macOS may still prompt the');
    lines.push('      first time an action runs — approve it and re-run rather than assuming');
    lines.push('      the step is broken.');
  }
  return lines.join('\n');
}

/** Where to send someone whose preflight failed. Kept next to the checks so the
 *  pointer cannot drift from the document that explains them. */
export const MIRROR_DOCS = 'packages/phone-use/docs/real-iphone.md';
