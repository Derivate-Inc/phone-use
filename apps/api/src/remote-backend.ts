// The sandbox RPC client moved into the SDK (backends/cloud-sandbox.ts) so the
// CLI/MCP/agent can attach to a sandbox without depending on this package.
// Re-exported here so existing imports keep working; the wire protocol types in
// types.ts stay the source for the server side.
export {
  CloudSandboxBackend as RemoteDeviceBackend,
  type CloudSandboxBackendOptions as RemoteDeviceBackendOptions,
} from '@phone-use/sdk';
