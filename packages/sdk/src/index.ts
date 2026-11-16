/**
 * @phone-use/sdk — the device runtime SDK: engine-as-object lifecycle
 * (ios.launch/connect and android.launch/connect → Device), Device backends, config, errors, capabilities,
 * and the action verb surface.
 *
 * The test double (FakeBackend) lives on the "@phone-use/sdk/testing" subpath,
 * deliberately not re-exported here.
 */
/** The published package version (kept in sync with package.json by the release flow). */
export const VERSION = '0.6.0';

export {
  type Action,
  type ActionResult,
  type ActionVerb,
  type ActOptions,
  buildObserveResult,
  type CompiledSkill,
  type ElementQuery,
  executeAction,
  type ObservedElement,
  type ObserveResult,
  toActions,
} from './actions.ts';
export { appleEnv, resolveDeveloperDir } from './apple.ts';
export {
  type BackendFactory,
  BaseDeviceBackend,
  type DeviceBackend,
  getBackendFactory,
  listBackends,
  type PressOutcome,
  registerBackend,
} from './backend.ts';
export {
  AndroidBackend,
  type AndroidBackendOptions,
  type AndroidConnectOptions,
  type AndroidDeviceInfo,
  type AndroidLaunchOptions,
  type AndroidListOptions,
  android,
  type BinaryExecRunner,
  createAndroidBackend,
  type EmulatorProcess,
} from './backends/android.ts';
export {
  CloudSandboxBackend,
  type CloudSandboxBackendOptions,
  createCloudSandboxBackend,
  type SandboxCheckpointInfo,
  type SandboxRpcFailure,
  type SandboxRpcMethod,
  type SandboxRpcRequest,
  type SandboxRpcResponse,
  type SandboxRpcSuccess,
} from './backends/cloud-sandbox.ts';
export {
  createDeviceRunnerBackend,
  DeviceRunnerBackend,
  type DeviceRunnerConfig,
} from './backends/device-runner.ts';
export { type IosConnectOptions, type IosLaunchOptions, ios } from './backends/ios.ts';
export {
  buildRunner,
  currentBuildKey,
  type EnsureRunnerOptions,
  ensureRunner,
  type RunnerEndpoint,
  runnerProjectDir,
  runnerState,
  runningApps,
  stopRunner,
} from './backends/ios-runner.ts';
export {
  type PrivacyService,
  type SimulatorCapture,
  type SimulatorTools,
  type SimulatorToolsOptions,
  simulator,
} from './backends/simulator.ts';
export {
  createXctestBackend,
  soleBootedSimulator,
  stopXctestRunner,
  type XctestBackendOptions,
} from './backends/xctest.ts';
export {
  CLOUD_WAITLIST_CODE,
  CLOUD_WAITLIST_URL,
  type CloudWaitlistContext,
  CloudWaitlistError,
  type CloudWaitlistLocalStep,
  type CloudWaitlistSurface,
  cloudWaitlistLocalStep,
  cloudWaitlistMessage,
} from './cloud-waitlist.ts';
export type { AndroidDeviceConfig, CommonDeviceConfig, DeviceConfig, IosDeviceConfig } from './config.ts';
export type {
  AlertAction,
  BackendAlertResult,
  Capability,
  OpenAppResult,
  PressTarget,
  Rect,
  ScrollDirection,
  ScrollOptions,
  Snapshot,
  SnapshotNode,
} from './device.ts';
export { ALL_CAPABILITIES } from './device.ts';
export {
  AbortedError,
  ActionFailedError,
  DeviceInUseError,
  DeviceNotFoundError,
  PhoneUseError,
  type PhoneUseErrorCode,
  type PhoneUseErrorDetails,
  SessionNotFoundError,
  TimeoutError,
  toPhoneUseError,
  UnsupportedCapabilityError,
} from './errors.ts';
export {
  type CreateDeviceHandleOptions,
  createDeviceHandle,
  type Device,
  type DevicePlatform,
  type DeviceStatus,
} from './lifecycle.ts';
export type {
  ActionEvidence,
  AlertOutcome,
  Observation,
  RenderState,
  Resolution,
  ResolveOpts,
  UiElement,
} from './observe.ts';
export { DeviceCore, describeError, labelMatches, matchInElements } from './observe.ts';
export { SecretStore } from './secrets.ts';

// Built-in backend registration — explicit, here, so importing the barrel
// registers it (documented; sideEffects:false refers to bundler tree-shaking
// of the *published* dist, where the barrel is the entry).
import { registerBackend as _register } from './backend.ts';
import { createAndroidBackend as _createAndroid } from './backends/android.ts';
import { createXctestBackend as _createXctest } from './backends/xctest.ts';

// The registry factory takes a DeviceConfig; with no udid it drives the one
// booted simulator (and refuses to guess when several are booted).
_register('xctest', (config) =>
  _createXctest({ udid: (config?.platform === 'ios' ? config.udid : undefined) ?? 'booted' }),
);
_register('android-adb', _createAndroid);
