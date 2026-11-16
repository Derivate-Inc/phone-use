# Reliable mobile runs

Implementation direction, 2026-10-28. This addresses the requested harness/CLI
improvements; it does not select a commercial strategy or supersede historical
benchmark reports.

## Research and design

- The third-party device runtime in use at the time: retain it behind our
  existing backend boundary. Its CLI/MCP/Node interfaces share sessions and
  execution; do not implement another native driver.
- [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision):
  Chat Completions accepts image content in user messages, including base64
  data URLs. Complete all tool-result messages before appending associated
  images; preserve tool-call IDs and label which tool produced each image.
- [Anthropic tool helpers](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md):
  retain the installed SDK's tool runner and return structured text/image
  blocks from tools. Validate against installed types, not upstream-only APIs.
- Existing AndroidWorld and iOSWorld reports demonstrate useful execution but
  do not establish a present-day comparative advantage. Freeze task contracts,
  reset environments per trial, use independent graders, and report false
  success and setup failures alongside success, latency, and model usage.

The coding agent remains the caller. Phone-use owns device execution and
evidence, not repository editing or general-purpose code orchestration.

## Contracts

1. A provider's final answer is an execution event, not proof. Runs without
   caller-supplied expectations are **unverified**. Only independently checked
   expectations can produce **verified**. Report failed expectations and
   unavailable evidence separately; never silently substitute a screenshot
   opinion for an unavailable state check.
2. Keep text tools backward compatible; add optional rich output to the model
   adapter boundary. Screenshot bytes must reach both model adapters, while
   step logs retain readable text rather than base64 payloads.
3. Isolate device context, permissions/grants, notes, recorder state, app
   inventory, and trace ownership per embedded session. Preserve process-default
   behavior for one-shot CLI commands. Caller-owned devices are never closed.
4. A declarative run has an immutable ID, ordered steps, explicit expectations,
   timings, actual device identity, evidence paths, and failure location. Save
   the input and result for reproduction, without automatically replaying
   side-effecting actions.
5. Recovery is bounded and conservative: retry observations/transient reads;
   do not retry uncertain mutations. Report how to recover rather than reset,
   erase, or switch devices implicitly.
6. Diagnostics respect the selected backend. Local iOS requires full Xcode,
   not Command Line Tools. Remote and Android users should not fail irrelevant
   local iOS prerequisites.

## Commit sequence

Research contract; multimodal adapters and prompt alignment; session isolation;
verified outcomes; diagnostics/recovery; declarative CLI run and evidence;
comparative evaluation runner and validation documentation.

## Validation

Use existing Vitest, TypeScript, and package build commands. Add wire-format
tests for model image transport, interleaved two-device/session tests, false
completion and unavailable-verifier tests, scripted diagnostic failures, and
end-to-end declarative runs over fake backends. Live device comparisons require
an available device, model access, and independently graded task fixtures;
unit tests must never be reported as comparative task performance.
