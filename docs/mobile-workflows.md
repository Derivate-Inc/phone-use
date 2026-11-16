# Verified mobile workflows

Phone-use adds an execution and verification layer to an existing coding agent.
Phone-use drives devices with its own layer: an XCTest runner on iOS simulators
(`packages/sdk/ios-runner`) and adb on
Android. (Until 2026-11-04 the iOS machinery was a third-party device runtime.)
Phone-use does not replace your coding agent's repository editing, planning, or
model choice.

## Run a workflow

From this repository:

```sh
bun packages/phone-use/src/index.ts doctor
bun packages/phone-use/src/index.ts run docs/examples/settings-check.json \
  --device launch --output ./artifacts --json
```

Installed CLI: replace the Bun invocation with `phone-use`. Local iOS needs full
Xcode and an installed simulator runtime. If Xcode is installed but Command Line
Tools is selected, phone-use finds the Xcode installation and sets
`DEVELOPER_DIR` for its own processes; global settings are not changed. The first
iOS command builds the runner (about 10 s, once per Xcode version).

The version-1 JSON contract contains a name, optional app bundle ID and install
path, ordered registry tool calls, and explicit expectations. All step arguments
are validated before execution. Supported expectations:

```json
[
  {"kind":"app","bundleId":"com.example.app"},
  {"kind":"screen","contains":"Saved","app":"com.example.app"},
  {"kind":"field","label":"Username","equals":"alice","app":"com.example.app"}
]
```

Screen checks prove visible accessibility content; they do not prove server
persistence. Field checks require a unique readable label or identifier.
SDK callers can supply independent API/database verifiers for persisted state:

```ts
const result = await session.prompt("Save the profile", {
  expectations: [{ kind: "screen", contains: "Saved" }],
  verifiers: [{
    id: "persisted-profile",
    async check(signal) {
      const response = await fetch(profileUrl, { signal });
      if (!response.ok) throw new Error("Profile unavailable");
      const profile = await response.json();
      return { ok: profile.name === "Alice", detail: "Checked stored profile" };
    },
  }],
});
```

A completed model answer alone now yields `unverified`. This changes the public
result status contract: `verified` (exit 0), `failed` (1), `unverified` (4),
or `stopped` (130). Internal runner execution status still uses `completed`.
Update integrations that treated completion or exit 0 as an unqualified success.
For simple natural-language CLI runs, add repeatable `--expect "text"`.

Workflow output directories contain the input, before/after observations,
screenshot, trace, and machine-readable result. A missing pre-launch app session
is recorded explicitly. Evidence capture errors are listed separately. Artifacts
can contain sensitive screen content; keep them local or apply your own retention
and redaction policy before sharing.

`run` supports local iOS (`launch`, `connect`, UDID), Android
(`--device android`), and configured sandbox backends
(`--device sandbox --platform ios|android`). Local Android requires authorized
ADB access. Remote runs need the existing sandbox endpoint configuration.
Installation support depends on the selected backend. Caller-owned SDK devices
are never closed; CLI-created simulators are cleaned up.

Embedded sessions isolate device context, grants, notes, recorder, and traces.
Simultaneous prompts/workflows on the same device are rejected within one process.
Use separately provisioned devices across processes: there is no distributed
device lease. Queued tool calls check cancellation before execution. In-flight
native mutations cannot necessarily be cancelled. Read probes are time-bounded
and retry once only for explicitly retryable errors; uncertain mutations are
never automatically retried.

## Compare harnesses

`phone-use compare contract.json --output ./comparisons` runs external CLI
adapters serially, resets each trial, independently grades it, and persists
the contract hash, subprocess output, trial records, and aggregate results.

```json
{
  "version": 1,
  "model": "your-exact-model-id",
  "seed": 42,
  "repetitions": 3,
  "timeoutMs": 300000,
  "tasks": [{
    "id": "save-profile",
    "goal": "Set the profile name to Alice",
    "state": "cold",
    "reset": ["bun", "eval/reset.ts"],
    "grade": ["bun", "eval/grade.ts"]
  }],
  "arms": [
    {"id": "phone-use", "command": ["bun", "eval/phone-use.ts"]},
    {"id": "baseline", "command": ["bun", "eval/baseline.ts"]}
  ]
}
```

Supply real reset, grader, and adapter programs for your test app. Commands are
argument arrays, executed without a shell. Each receives `PHONE_USE_EVAL_GOAL`,
`TASK`, `MODEL`, `ARM`, `SEED`, `REPETITION`, `STATE`, and `DIR` with
the same `PHONE_USE_EVAL_` prefix. Reset must exit zero. Adapter stdout must
contain one JSON object:

```json
{"model":"your-exact-model-id","reportedStatus":"verified","modelCalls":3,"inputTokens":1200,"outputTokens":300,"costUsd":0.01}
```

Usage fields are optional; omitted costs remain unknown. Send logs to stderr.
The grader independently inspects actual app/backend state and prints
`{"passed":true}` or `{"passed":false}`. A model-name mismatch is rejected.
A claimed verified result with a failing grader is counted as false success.

Cold trials receive fresh knowledge paths; warm trials reuse paths per task and
arm. External adapters must honor these paths and clear their own caches when
needed. Keep device/app versions, model settings, credentials, reset behavior,
and task budgets identical. The runner cannot enforce honest reporting by an
arbitrary external command. Graders must not use the agent's narrative as proof.
Timeouts terminate subprocess groups on Unix; external services need their own
cleanup. Inspect setup failures and ungraded trials alongside success rates.

## Validation and limits

On 2026-10-28, a live iOS 26.5 simulator run opened Settings, observed its
accessibility tree, independently checked the foreground app and General text,
and saved all evidence without capture errors. The verified execution took
14.5 seconds excluding simulator provisioning. The simulator was cleaned up.

Automated tests cover provider image wire formats, failed and unavailable
verification, interleaved session isolation, workflow evidence and cancellation,
and comparison reset/grader/timeout behavior. This is functional validation,
not evidence of superiority over other setups.
Real-device Android, remote backends, and competitive model-driven task suites
still need environment-specific live evaluation.

Final local checks: 369 tests across 55 files passed; phone-use TypeScript check,
SDK and CLI builds, and the repository's ESM package publication checks passed.

### Cloud startup regression, 2026-10-29

A fresh cloud iOS run exposed a post-launch accessibility probe exceeding the
ordinary 15-second read budget. Settings was visible afterward, but the workflow
correctly failed before executing navigation. Startup now has a separate
60-second readiness deadline: launch once, then read until the requested app
is foreground with a nonempty accessibility tree. Transient startup errors and
foreground transitions can be polled; permanent errors fail immediately.
Cancellation is honored, and a hanging snapshot does not cause overlapping
startup probes. Readiness failures identify their own phase.

With this fix, a newly provisioned cloud iOS phone completed
[Settings → General → About](examples/settings-navigation.json), independently
verified the foreground app, iOS Version and Model Name text, and saved all
evidence without capture errors. Execution took 38.1 seconds, excluding cloud
provisioning. This validates the declarative cloud path, not a model-driven
benchmark or a guarantee that all cold starts finish within the deadline.
