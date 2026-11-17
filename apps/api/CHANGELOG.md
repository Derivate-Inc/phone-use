# @phone-use/cloud

## 0.1.1

### Patch Changes

- Updated dependencies [4fce319]
  - @phone-use/sdk@0.7.1

## 0.1.0

### Minor Changes

- 0cb619c: Cloud phones are on a waitlist; phone-use stays free on your own machine.

  - `phone-use create` with no key, or from an account that is not approved, no longer fails with a bare error. It prints a short message written for a coding agent (cloud phones are on a waitlist, the exact command that continues on the local simulator, and the waitlist link to tell the user) and exits `1`. `--json` puts the same facts on stdout with `code: "cloud_waitlist"`.
  - The MCP server gains `create_cloud_phone`, which returns the same text as a structured error.
  - `@phone-use/sdk` exports `CloudWaitlistError` (`CLOUD_WAITLIST`, not retryable) and `cloudWaitlistMessage()`.
  - The control plane refuses `POST /v1/sandboxes` from an account that is not approved with HTTP 403 and `code: "cloud_waitlist"`, counts each refusal (time, account, platform and client kind; no IP address), and adds the waitlist form and admin approval routes.

  Approved accounts create cloud phones as before. Local commands are unchanged and send nothing to phone-use's servers.

### Patch Changes

- Updated dependencies [0cb619c]
  - @phone-use/sdk@0.7.0

## 0.0.5

### Patch Changes

- Updated dependencies [69efe61]
- Updated dependencies [605a91b]
- Updated dependencies [ec0ad28]
- Updated dependencies [e657330]
  - @phone-use/sdk@0.6.0

## 0.0.4

### Patch Changes

- Updated dependencies [63f389f]
  - @phone-use/sdk@0.5.2

## 0.0.3

### Patch Changes

- Updated dependencies [dc03cab]
  - @phone-use/sdk@0.5.1

## 0.0.2

### Patch Changes

- Updated dependencies [0dba0b3]
  - @phone-use/sdk@0.5.0

## 0.0.1

### Patch Changes

- Updated dependencies [2517579]
  - @phone-use/sdk@0.4.1
