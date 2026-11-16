// ---------------------------------------------------------------------------
// Device configuration: a discriminated union, never a stringly-typed
// capability blob (learning from Appium's leaks).
// Plain types — no zod in the SDK public API.
// ---------------------------------------------------------------------------

/** Fields shared by every platform's device config. */
export type CommonDeviceConfig = Record<never, never>;

/** iOS device selection: pin by udid, name match, or custom device set. */
export type IosDeviceConfig = CommonDeviceConfig & {
  platform: 'ios';
  /** Pin a specific simulator/device by udid. */
  udid?: string | undefined;
  /** Name match, e.g. "iPhone 16". */
  device?: string | undefined;
  /** Custom simulator device set directory. */
  simulatorDeviceSet?: string | undefined;
};

/** Android device selection: pin by adb serial or name match. */
export type AndroidDeviceConfig = CommonDeviceConfig & {
  platform: 'android';
  /** Pin a specific device/emulator by adb serial. */
  serial?: string | undefined;
  /** Name match. */
  device?: string | undefined;
};

/**
 * Device configuration: a discriminated union on `platform`, never a
 * stringly-typed capability blob (learning from Appium's leaks).
 * Plain types — no zod in the SDK public API.
 */
export type DeviceConfig = IosDeviceConfig | AndroidDeviceConfig;
