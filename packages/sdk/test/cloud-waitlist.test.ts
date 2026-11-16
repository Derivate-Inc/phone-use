import { describe, expect, it } from 'vitest';
import {
  CLOUD_WAITLIST_URL,
  CloudWaitlistError,
  cloudWaitlistLocalStep,
  cloudWaitlistMessage,
  PhoneUseError,
} from '../src/index.ts';

describe('cloud waitlist message', () => {
  it('tells a coding agent the three things: waitlist, the local next step, what to tell the user', () => {
    const message = cloudWaitlistMessage({ surface: 'cli', platform: 'ios', hostPlatform: 'darwin' });
    expect(message).toBe(
      [
        'Cloud phones are on a waitlist, so no cloud phone was created.',
        '',
        'You can keep working on this machine without an account, on the local iOS Simulator:',
        '  open -a Simulator && PHONE_USE_DEVICE=connect PHONE_USE_SANDBOX_URL= PHONE_USE_RUNNER_URL= phone-use observe',
        'If it says no simulator is booted, wait a few seconds and retry the same command. `phone-use doctor` checks the setup.',
        '',
        'Tell the user: cloud phones are on a waitlist, and they can join it at https://phoneuse.dev/waitlist',
      ].join('\n'),
    );
  });

  it('adds how to sign in only when no key was present', () => {
    const base = { surface: 'cli', platform: 'ios', hostPlatform: 'darwin' } as const;
    expect(cloudWaitlistMessage({ ...base, signedIn: true })).not.toContain('phone-use login');
    expect(cloudWaitlistMessage({ ...base, signedIn: false })).toContain(
      'If their account is already approved, run `phone-use login` and try again.',
    );
    expect(cloudWaitlistMessage({ ...base, surface: 'sdk', signedIn: false })).toContain(
      'PHONE_USE_CLOUD_TOKEN',
    );
  });

  it('gives the exact next step for each surface and platform', () => {
    const step = (
      surface: 'cli' | 'mcp' | 'sdk',
      platform: 'ios' | 'android',
      hostPlatform: string,
    ): string => cloudWaitlistLocalStep({ surface, platform, hostPlatform }).command;

    expect(step('cli', 'ios', 'darwin')).toBe(
      'open -a Simulator && PHONE_USE_DEVICE=connect PHONE_USE_SANDBOX_URL= PHONE_USE_RUNNER_URL= phone-use observe',
    );
    expect(step('cli', 'android', 'darwin')).toBe('PHONE_USE_DEVICE=android phone-use observe');
    expect(step('mcp', 'ios', 'darwin')).toBe(step('cli', 'ios', 'darwin'));
    expect(step('mcp', 'android', 'linux')).toBe(step('cli', 'android', 'linux'));
    expect(step('sdk', 'ios', 'darwin')).toContain('await ios.launch()');
    expect(step('sdk', 'android', 'linux')).toContain('await android.connect()');
  });

  it('says what to do when the simulator is not up yet, right under the step', () => {
    // `open -a Simulator` returns before the device has booted, so the first
    // observe after a cold start can fail; the message must not leave an agent there.
    const cli = cloudWaitlistMessage({ surface: 'cli', platform: 'ios', hostPlatform: 'darwin' }).split('\n');
    expect(cli[4]).toContain('If it says no simulator is booted');
    expect(cli[4]).toContain('retry the same command');
    const mcp = cloudWaitlistMessage({ surface: 'mcp', platform: 'ios', hostPlatform: 'darwin' });
    expect(mcp).toContain('wait a few seconds and retry the same command');
    expect(mcp).toContain('This MCP server stays bound to its original device');
    expect(mcp).toContain('phone-use mcp --devices local=connect');
    const androidMcp = cloudWaitlistMessage({ surface: 'mcp', platform: 'android', hostPlatform: 'linux' });
    expect(androidMcp).toContain('Run this in a shell');
    expect(androidMcp).toContain('phone-use mcp --devices local=android');
    expect(
      cloudWaitlistLocalStep({ surface: 'sdk', platform: 'ios', hostPlatform: 'darwin' }).note,
    ).toBeUndefined();
  });

  it('does not send a Linux machine to the iOS Simulator', () => {
    const message = cloudWaitlistMessage({ surface: 'cli', platform: 'ios', hostPlatform: 'linux' });
    expect(message).toContain('The iOS Simulator needs a Mac');
    expect(message).toContain('PHONE_USE_DEVICE=android phone-use observe');
    expect(message).not.toContain('open -a Simulator');
  });

  it('uses the link the control plane sent, and the default one otherwise', () => {
    expect(cloudWaitlistMessage({ surface: 'cli' })).toContain(CLOUD_WAITLIST_URL);
    expect(cloudWaitlistMessage({ surface: 'cli', waitlistUrl: 'https://example.test/join' })).toContain(
      'they can join it at https://example.test/join',
    );
  });
});

describe('CloudWaitlistError', () => {
  it('is a PhoneUseError with a stable code, not retryable, carrying the two actionable parts', () => {
    const error = new CloudWaitlistError({
      surface: 'sdk',
      platform: 'ios',
      hostPlatform: 'darwin',
      waitlistUrl: 'https://example.test/join',
    });
    expect(error).toBeInstanceOf(PhoneUseError);
    expect(error.name).toBe('CloudWaitlistError');
    expect(error.code).toBe('CLOUD_WAITLIST');
    expect(error.retryable).toBe(false);
    expect(error.waitlistUrl).toBe('https://example.test/join');
    expect(error.localCommand).toContain('await ios.launch()');
    expect(error.message).toBe(
      cloudWaitlistMessage({
        surface: 'sdk',
        platform: 'ios',
        hostPlatform: 'darwin',
        waitlistUrl: 'https://example.test/join',
      }),
    );
    expect(error.details).toMatchObject({ backendCode: 'cloud_waitlist', surface: 'sdk' });
  });
});
