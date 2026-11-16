export type DocBlock =
  | { type: "paragraph"; text: string }
  | { type: "code"; code: string; language?: string }
  | { type: "list"; items: string[] }
  | { type: "steps"; items: { title: string; text: string; code?: string }[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "callout"; tone?: "note" | "warning"; text: string };

export type DocSection = {
  title: string;
  blocks: DocBlock[];
};

export type DocPage = {
  slug: string;
  title: string;
  description: string;
  eyebrow: string;
  sections: DocSection[];
};

const pages: DocPage[] = [
  {
    slug: "introduction",
    title: "Phone Use",
    description: "Phones for AI agents: free on your own machine, with cloud phones on a waitlist.",
    eyebrow: "Start",
    sections: [
      {
        title: "What Phone Use does",
        blocks: [
          {
            type: "paragraph",
            text: "Phone Use gives AI agents phones to work on. On your own machine it is free and needs no account: it drives the iOS Simulator on a Mac, or an Android device or emulator over adb. Agents drive them through the CLI, the MCP server or the TypeScript SDK, with the same verbs on both platforms, and every action is checked. Cloud phones, which run on our hardware, are on a waitlist.",
          },
          {
            type: "table",
            headers: ["Surface", "Best for", "Model required"],
            rows: [
              ["CLI verbs", "Coding agents and shell automation", "No"],
              ["MCP server", "Tool-capable agent clients", "The client supplies the agent"],
              ["phone-use task", "A complete natural-language goal", "Yes"],
              ["TypeScript SDK", "Product and infrastructure integration", "No"],
              ["Compiled skills", "Reliable repeated workflows", "No"],
            ],
          },
        ],
      },
      {
        title: "Semantic control",
        blocks: [
          {
            type: "paragraph",
            text: "Phone Use reads the native accessibility hierarchy and targets elements by meaning. Vision and coordinates remain available for interfaces that do not expose enough structure.",
          },
        ],
      },
      {
        title: "Checked outcomes",
        blocks: [
          {
            type: "paragraph",
            text: "Actions report whether the screen changed, and workflows can assert postconditions. A run completes because the desired state was observed—not because a model said it was done.",
          },
        ],
      },
      {
        title: "Learned routes and skills",
        blocks: [
          {
            type: "paragraph",
            text: "App Cartographer turns explored screens into a persistent graph. Known routes and successful workflows replay deterministically with zero model calls.",
          },
          {
            type: "callout",
            text: "With no cloud phone attached, Phone Use drives a local iOS Simulator on macOS with Xcode, or an Android emulator over adb (`phone-use connect android`, or `android.connect()` from the SDK). Cloud phones run iOS simulators on managed Mac hardware and Android emulators on Linux hosts; they are on a waitlist at https://phoneuse.dev/waitlist.",
          },
        ],
      },
    ],
  },
  {
    slug: "quickstart",
    title: "Quickstart",
    description: "Drive the simulator on your own machine and run your first commands. No account needed.",
    eyebrow: "Start",
    sections: [
      {
        title: "Prerequisites",
        blocks: [
          {
            type: "list",
            items: [
              "macOS or Linux. The install script adds Bun 1.3 or newer, which the CLI runs on, if it is missing.",
              "For iOS: a Mac with Xcode and an iOS Simulator runtime. For Android: adb and an emulator or a device, on macOS or Linux.",
              "No account. Phone Use is free on your own machine.",
            ],
          },
        ],
      },
      {
        title: "Run your first command",
        blocks: [
          {
            type: "steps",
            items: [
              {
                title: "Install Phone Use",
                text: "The script installs Bun if it is missing, then the CLI. Run it again to update. `phone-use doctor` checks your setup.",
                code: "curl -fsSL https://phoneuse.dev/install | bash",
              },
              {
                title: "Start a simulator",
                text: "On a Mac this opens the iOS Simulator; with no other device chosen, every verb drives it. For Android, attach an emulator or a device and run `phone-use connect android` instead.",
                code: "open -a Simulator",
              },
              {
                title: "Inspect the screen",
                text: "Read the frontmost app and its visible elements. If it says no simulator is booted, the Simulator is still starting: run it again in a few seconds.",
                code: "phone-use observe",
              },
              {
                title: "Navigate and read",
                text: "Use the saved app map to reach About and read a labeled value.",
                code: 'phone-use goto Settings About\nphone-use ask "iOS Version" --app Settings',
              },
            ],
          },
        ],
      },
      {
        title: "Run a complete goal",
        blocks: [
          {
            type: "paragraph",
            text: "The built-in agent loop can execute a natural-language task. It requires `ANTHROPIC_API_KEY`.",
          },
          {
            type: "code",
            language: "bash",
            code: 'export ANTHROPIC_API_KEY="..."\nphone-use task "Open Settings and go to Accessibility"',
          },
        ],
      },
      {
        title: "Cloud phones (waitlist)",
        blocks: [
          {
            type: "paragraph",
            text: "Cloud phones run on our hardware, so they need no Mac and no Xcode. There are only a few of them, and they are on a waitlist: join at https://phoneuse.dev/waitlist.",
          },
          {
            type: "paragraph",
            text: "`phone-use create ios` from an account that is not approved creates nothing. It prints how to continue on the local simulator and where to join the waitlist, and exits with a non-zero code. Once your account is approved, follow the Cloud quickstart.",
          },
        ],
      },
    ],
  },
  {
    slug: "installation",
    title: "Installation",
    description: "Install the CLI, harness, and TypeScript SDK.",
    eyebrow: "Start",
    sections: [
      {
        title: "Packages",
        blocks: [
          {
            type: "table",
            headers: ["Package", "Purpose", "Runtime"],
            rows: [
              ["phone-use", "CLI, MCP, agent loop, maps, skills, viewer, traces", "Bun 1.3+"],
              ["@phone-use/sdk", "Typed lifecycle and observe/act API", "Node 22+ or Bun"],
            ],
          },
        ],
      },
      {
        title: "Install the CLI",
        blocks: [
          { type: "code", language: "bash", code: "curl -fsSL https://phoneuse.dev/install | bash\nphone-use --help" },
          {
            type: "paragraph",
            text: "The CLI runs on Bun 1.3 or newer. The script installs Bun if it is missing, then installs the CLI with `bun add --global phone-use`. Run it again to update.",
          },
          {
            type: "paragraph",
            text: "With Bun already installed, you can use a package manager instead: `npm install -g phone-use`, `bun add --global phone-use`, or per project `bun add phone-use` and `bunx phone-use`.",
          },
        ],
      },
      {
        title: "Install the SDK",
        blocks: [
          { type: "code", language: "bash", code: "npm install @phone-use/sdk" },
        ],
      },
      {
        title: "Choose a device",
        blocks: [
          {
            type: "paragraph",
            text: "With nothing chosen, the CLI drives the one booted iOS Simulator. For the MCP server, choose a local device when you start it. A cloud phone (waitlist) needs no device flag: attach it with `eval \"$(phone-use env <id>)\"`.",
          },
          {
            type: "code",
            language: "bash",
            code: "phone-use mcp --device launch\nphone-use mcp --device connect\nphone-use mcp --device <simulator-udid>\nphone-use mcp --device android",
          },
          {
            type: "callout",
            tone: "warning",
            text: "Phone Use is pre-1.0. Pin exact versions in production integrations because minor releases may change the public surface.",
          },
        ],
      },
    ],
  },
  {
    slug: "guides/cli",
    title: "Use the CLI",
    description: "Operate a phone with composable one-shot shell commands.",
    eyebrow: "Use Phone Use",
    sections: [
      {
        title: "Start with observation",
        blocks: [
          { type: "code", language: "bash", code: "phone-use observe" },
          {
            type: "paragraph",
            text: "Target elements by label. Element references such as `@e4` belong to one observation and should not cross separate CLI invocations.",
          },
        ],
      },
      {
        title: "Device primitives",
        blocks: [
          {
            type: "code",
            language: "bash",
            code: 'phone-use open Settings\nphone-use tap "General"\nphone-use type "Ada" --field "First name"\nphone-use press return --yes\nphone-use scroll down\nphone-use scroll down --until "Developer"\nphone-use scroll down --collect\nphone-use nav back\nphone-use wait_for "About"\nphone-use wait_for --stable',
          },
        ],
      },
      {
        title: "Intent verbs",
        blocks: [
          {
            type: "code",
            language: "bash",
            code: 'phone-use goto Settings About\nphone-use ask "Model Name" --app Settings\nphone-use search Maps coffee --open\nphone-use toggle Settings "Full-Screen Previews" --on',
          },
          {
            type: "list",
            items: [
              "`goto` computes and replays the shortest known route.",
              "`ask` finds a labeled value and reads it.",
              "`search` handles native search patterns and can open a matching result.",
              "`toggle` sets the requested switch state idempotently.",
            ],
          },
        ],
      },
      {
        title: "Carry data between commands",
        blocks: [
          {
            type: "code",
            language: "bash",
            code: 'export PHONE_USE_NOTES="$PWD/.phone-use-notes.json"\nphone-use note save device-model "iPhone 17 Pro"\nphone-use note read device-model',
          },
        ],
      },
    ],
  },
  {
    slug: "guides/mcp",
    title: "Connect an MCP client",
    description: "Expose Phone Use tools to Claude Code, Codex, or another MCP-compatible client.",
    eyebrow: "Use Phone Use",
    sections: [
      {
        title: "Register the server",
        blocks: [
          {
            type: "code",
            language: "bash",
            code: "claude mcp add --scope project phone-use -- bunx phone-use mcp",
          },
        ],
      },
      {
        title: "Choose a device",
        blocks: [
          {
            type: "table",
            headers: ["Value", "Behavior"],
            rows: [
              ["launch", "Create and boot a dedicated simulator; delete it on exit"],
              ["connect", "Attach to the first booted simulator"],
              ["Simulator UDID", "Attach to that simulator"],
            ],
          },
        ],
      },
      {
        title: "Drive several phones",
        blocks: [
          {
            type: "paragraph",
            text: "One agent can drive several phones through one server, for example to send a message on one phone and read it on another. Name each phone with `--devices` or `PHONE_USE_DEVICES`.",
          },
          {
            type: "code",
            language: "bash",
            code: "phone-use mcp --devices a=<simulator-udid>,b=<simulator-udid>\nphone-use mcp --devices ios=launch,pixel=android:emulator-5554\nphone-use mcp --devices a=cloud:<sandbox-id>,b=cloud:<sandbox-id>",
          },
          {
            type: "list",
            items: [
              "A device is a simulator UDID, `launch`, `connect`, `android`, `android:<serial>`, or `cloud:<sandbox-id>`.",
              "Every tool except `note` takes an optional `phone` argument. Leaving it out uses the first phone.",
              "Each result starts with `[phone <name>]`, and calls to different phones can run at the same time.",
              "The `note` scratchpad is shared, so a value read on one phone can be typed on another.",
              "Prefer simulators that are already booted: `launch` boots one per phone at startup, which can take longer than an MCP client waits.",
            ],
          },
        ],
      },
      {
        title: "Live viewer",
        blocks: [
          {
            type: "paragraph",
            text: "Starting the MCP server also starts the browser viewer at `http://localhost:4936`.",
          },
        ],
      },
      {
        title: "Tool selection",
        blocks: [
          {
            type: "list",
            items: [
              "Use `ask`, `goto`, `search`, or `toggle` when the intent is known.",
              "Use a saved `skill` for an established multi-step workflow.",
              "Use `observe`, `tap`, `type`, and `scroll` for unfamiliar interfaces.",
              "Use coordinates only when no reliable semantic target exists.",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "guides/agent-sessions",
    title: "Embed an agent session",
    description: "Give a natural-language goal to the built-in Phone Use agent loop.",
    eyebrow: "Use Phone Use",
    sections: [
      {
        title: "Create a session",
        blocks: [
          {
            type: "code",
            language: "ts",
            code: 'import { createSession } from "phone-use";\nimport { ios } from "@phone-use/sdk";\n\nconst device = await ios.launch();\nconst session = createSession({\n  device,\n  onConfirm: (request) => {\n    console.log(request.summary);\n    return false;\n  },\n});\n\nconst result = await session.prompt(\n  "Open Settings and read the iOS version"\n);\n\nconsole.log(result.status, result.summary);\nawait device.close();',
          },
        ],
      },
      {
        title: "Requirements",
        blocks: [
          {
            type: "list",
            items: [
              "`ANTHROPIC_API_KEY` must be set for the built-in agent loop.",
              "The caller owns the device and must close it.",
              "If `onConfirm` is omitted, confirmation-tier actions are denied.",
              "The destructive-action permission floor cannot be disabled.",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "concepts/runtime",
    title: "Runtime architecture",
    description: "How the SDK, harness, maps, skills, and agent surfaces fit together.",
    eyebrow: "Core concepts",
    sections: [
      {
        title: "One runtime",
        blocks: [
          {
            type: "code",
            language: "text",
            code: "Agent or application\n        │\n   CLI · MCP · createSession()\n        │\n   Shared tool registry\n        │\n  Permissions · traces\n        │\n Maps · intent verbs · skills\n        │\n    @phone-use/sdk\n        │\n  Phone Use iOS backend\n        │\n    iOS Simulator",
          },
        ],
      },
      {
        title: "Device layer",
        blocks: [
          {
            type: "paragraph",
            text: "`@phone-use/sdk` owns lifecycle, observation, action resolution, waiting, normalized errors, and backend capabilities. Transport-specific types do not cross its public boundary.",
          },
        ],
      },
      {
        title: "When model calls happen",
        blocks: [
          {
            type: "table",
            headers: ["Operation", "Model calls"],
            rows: [
              ["SDK action", "0"],
              ["CLI primitive", "0"],
              ["Known goto route", "0"],
              ["Saved skill replay", "0"],
              ["phone-use task", "Yes"],
              ["MCP tool use", "Determined by the client agent"],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "concepts/observe",
    title: "Observe",
    description: "Convert a native interface into compact, actionable structure.",
    eyebrow: "Core concepts",
    sections: [
      {
        title: "Structured observation",
        blocks: [
          { type: "code", language: "bash", code: "phone-use observe" },
          {
            type: "code",
            language: "text",
            code: 'App: Settings\n\n@e1 [Button] "General" (16,74 82x44)\n@e2 [StaticText] "iOS Version" (20,188 103x22)\n@e3 [StaticText] "26.1" (329,188 41x22)',
          },
        ],
      },
      {
        title: "Accessibility first",
        blocks: [
          {
            type: "steps",
            items: [
              { title: "Identifier", text: "Prefer the stable accessibility identifier." },
              { title: "Exact label", text: "Match visible text exactly." },
              { title: "Substring", text: "Relax to a contained label." },
              { title: "Fuzzy label", text: "Handle punctuation and spacing variants." },
            ],
          },
        ],
      },
      {
        title: "Vision fallback",
        blocks: [
          {
            type: "paragraph",
            text: "Canvases, maps, and custom controls may expose insufficient structure. Phone Use can use screenshots, Set-of-Marks annotations, zoomed regions, and raw coordinates for those cases.",
          },
        ],
      },
    ],
  },
  {
    slug: "concepts/verification",
    title: "Outcome verification",
    description: "Confirm that an action or workflow produced the intended state.",
    eyebrow: "Core concepts",
    sections: [
      {
        title: "Action evidence",
        blocks: [
          {
            type: "code",
            language: "ts",
            code: 'const result = await device.tap("General");\n\nconsole.log(result.success);\nconsole.log(result.changed);\nconsole.log(result.message);',
          },
          {
            type: "paragraph",
            text: "An unchanged screen is evidence that the action may not have landed. The caller can retry, choose another target, or inspect an alert instead of continuing blindly.",
          },
        ],
      },
      {
        title: "Postconditions",
        blocks: [
          {
            type: "code",
            language: "json",
            code: '[\n  { "do": "tap", "label": "General" },\n  { "do": "verify", "contains": "About" }\n]',
          },
        ],
      },
    ],
  },
  {
    slug: "concepts/app-maps",
    title: "App maps",
    description: "Build a persistent graph of screens and deterministic routes.",
    eyebrow: "Core concepts",
    sections: [
      {
        title: "Inspect learned knowledge",
        blocks: [
          { type: "code", language: "bash", code: "phone-use atlas\nphone-use atlas inspect Settings" },
          {
            type: "paragraph",
            text: "Maps persist under `~/.phone-use/maps/<bundle-id>.json`.",
          },
        ],
      },
      {
        title: "Build or extend a map",
        blocks: [
          { type: "code", language: "bash", code: "phone-use atlas map Settings --maxScreens 14" },
        ],
      },
      {
        title: "Navigate with the map",
        blocks: [
          { type: "code", language: "bash", code: "phone-use goto Settings About" },
          {
            type: "list",
            items: [
              "Load the app map.",
              "Locate the destination.",
              "Compute the shortest route.",
              "Execute each transition.",
              "Observe the destination.",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "concepts/skills",
    title: "Skills",
    description: "Record, parameterize, and replay verified phone workflows.",
    eyebrow: "Core concepts",
    sections: [
      {
        title: "Save a workflow",
        blocks: [
          {
            type: "code",
            language: "bash",
            code: "phone-use skill save check-device \\\n  --steps '[{\"op\":\"goto\",\"app\":\"Settings\",\"destination\":\"About\"},{\"op\":\"ask\",\"app\":\"Settings\",\"field\":\"iOS Version\"},{\"op\":\"verify\",\"contains\":\"iOS Version\"}]'",
          },
          {
            type: "callout",
            text: "Recording belongs in a persistent MCP or embedded session. Separate one-shot CLI processes do not share an in-memory recording session.",
          },
        ],
      },
      {
        title: "Run a skill",
        blocks: [
          { type: "code", language: "bash", code: "phone-use skill run check-device" },
        ],
      },
      {
        title: "Capture and reuse values",
        blocks: [
          {
            type: "code",
            language: "json",
            code: '{\n  "op": "ask",\n  "app": "Settings",\n  "field": "Model Name",\n  "as": "model"\n}',
          },
          {
            type: "paragraph",
            text: "Later steps can interpolate captured values with `{{model}}`. Add a `verify` step when the skill must assert its final state.",
          },
        ],
      },
    ],
  },
  {
    slug: "concepts/permissions",
    title: "Permission floor",
    description: "Understand allow, confirmation, and deny decisions.",
    eyebrow: "Core concepts",
    sections: [
      {
        title: "Decisions",
        blocks: [
          {
            type: "table",
            headers: ["Decision", "Behavior"],
            rows: [
              ["Allow", "Execute immediately"],
              ["Ask", "Require explicit confirmation"],
              ["Deny", "Refuse the action"],
            ],
          },
        ],
      },
      {
        title: "CLI confirmation",
        blocks: [
          {
            type: "code",
            language: "bash",
            code: 'phone-use tap "Delete Contact"\n# exits 3\n\nphone-use tap "Delete Contact" --yes',
          },
        ],
      },
      {
        title: "Hard floor",
        blocks: [
          {
            type: "callout",
            tone: "warning",
            text: "No mode, environment variable, or system prompt bypasses confirmation for destructive targets. `--yes` can satisfy confirmation; it cannot override a deny decision.",
          },
        ],
      },
    ],
  },
  {
    slug: "sdk/overview",
    title: "SDK overview",
    description: "Launch, observe, and control devices with @phone-use/sdk.",
    eyebrow: "TypeScript SDK",
    sections: [
      {
        title: "Launch and act",
        blocks: [
          {
            type: "code",
            language: "ts",
            code: 'import { ios } from "@phone-use/sdk";\n\nconst device = await ios.launch();\nawait device.apps.open("Settings");\nconst result = await device.tap("General");\n\nconsole.log(result.message, result.changed);\nawait device.close();',
          },
        ],
      },
      {
        title: "Design goals",
        blocks: [
          {
            type: "list",
            items: [
              "Typed, transport-neutral public API",
              "Re-resolvable semantic actions instead of stale handles",
              "Automatic waiting and screen settling",
              "Structured results for normal action failures",
              "Stable error codes for infrastructure failures",
              "Device-free test doubles",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "sdk/device-lifecycle",
    title: "Device lifecycle",
    description: "Launch dedicated simulators or connect to existing devices.",
    eyebrow: "TypeScript SDK",
    sections: [
      {
        title: "Launch a dedicated simulator",
        blocks: [
          {
            type: "code",
            language: "ts",
            code: 'const device = await ios.launch();\ntry {\n  await device.apps.open("Settings");\n} finally {\n  await device.close();\n}',
          },
          {
            type: "paragraph",
            text: "`ios.launch()` creates and boots a dedicated simulator. Closing the device shuts down and deletes that simulator.",
          },
        ],
      },
      {
        title: "Connect to a booted simulator",
        blocks: [
          { type: "code", language: "ts", code: "const device = await ios.connect();" },
          {
            type: "paragraph",
            text: "A connected simulator is not deleted when the handle closes.",
          },
        ],
      },
      {
        title: "Explicit resource management",
        blocks: [
          {
            type: "code",
            language: "ts",
            code: 'await using device = await ios.connect();\nawait device.apps.open("Settings");\nconsole.log((await device.observe()).rendered);',
          },
        ],
      },
    ],
  },
  {
    slug: "sdk/observe-and-act",
    title: "Observe and act",
    description: "Build portable semantic actions and execute them against the live screen.",
    eyebrow: "TypeScript SDK",
    sections: [
      {
        title: "Observe",
        blocks: [
          {
            type: "code",
            language: "ts",
            code: "const observation = await device.observe();\n\nconsole.log(observation.rendered);\nconsole.log(observation.elements);",
          },
        ],
      },
      {
        title: "Portable actions",
        blocks: [
          {
            type: "code",
            language: "ts",
            code: "const observation = await device.observe();\nconst [firstAction] = observation.actions;\n\nif (firstAction) {\n  await device.act(firstAction);\n}",
          },
        ],
      },
      {
        title: "Secrets",
        blocks: [
          {
            type: "code",
            language: "ts",
            code: 'device.secrets.set("password", process.env.APP_PASSWORD!);\n\nawait device.type("%password%", {\n  field: "Password",\n  submit: true,\n});',
          },
        ],
      },
    ],
  },
  {
    slug: "sdk/testing",
    title: "Testing",
    description: "Test device workflows without launching a simulator.",
    eyebrow: "TypeScript SDK",
    sections: [
      {
        title: "Create a fake backend",
        blocks: [
          {
            type: "code",
            language: "ts",
            code: 'import { FakeBackend, el, screen } from "@phone-use/sdk/testing";\n\nconst backend = new FakeBackend({\n  screens: [\n    screen([\n      el({ ref: "1", role: "Button", label: "General" }),\n    ]),\n  ],\n});',
          },
        ],
      },
      {
        title: "Included utilities",
        blocks: [
          {
            type: "table",
            headers: ["Utility", "Purpose"],
            rows: [
              ["FakeBackend", "Play scripted screens and record calls"],
              ["el", "Create an observed-element fixture"],
              ["screen", "Create a snapshot fixture"],
              ["scriptedExecRunner", "Test lifecycle and command execution paths"],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "reference/cli",
    title: "CLI reference",
    description: "Command groups and usage patterns for the phone-use CLI.",
    eyebrow: "Reference",
    sections: [
      {
        title: "Top-level commands",
        blocks: [
          {
            type: "table",
            headers: ["Command", "Description"],
            rows: [
              ["phone-use login", "Sign in and save an API key to ~/.phone-use/config.json"],
              ["phone-use login --device", "Headless sign-in (SSH, Docker, CI): approve a short code at app.phoneuse.dev/device"],
              ["phone-use login --key pk_…", "Paste an existing key (self-host or automation)"],
              ["phone-use create <ios|android>", "Provision a cloud phone (iOS starts in about 2s, warm)"],
              ["phone-use list", "List your cloud phones"],
              ["phone-use env <id>", "Print PHONE_USE_SANDBOX_* exports for a phone"],
              ["phone-use close <id>", "Close a cloud phone"],
              ["phone-use install <path>", "Install a local iOS simulator build (.app or .zip) onto the attached cloud phone"],
              ["phone-use vm <sub>", "Operator: rent and bootstrap simulator hosts"],
              ["phone-use connect android", "Drive a local Android emulator over adb"],
              ["phone-use doctor", "Check Bun, Xcode, simulators and keys"],
              ["phone-use mcp", "Start the MCP server and live viewer"],
              ['phone-use task "<goal>"', "Run a natural-language goal"],
              ["phone-use bench", "Run the deterministic benchmark"],
              ["phone-use atlas", "Show learned maps and skills"],
              ["phone-use export [file]", "Export maps and skills"],
              ["phone-use inspect <file>", "Preview an atlas file"],
              ["phone-use import <file>", "Merge an atlas file"],
            ],
          },
        ],
      },
      {
        title: "Registry verbs",
        blocks: [
          {
            type: "paragraph",
            text: "`observe` · `screenshot` · `wait_for` · `tap` · `type` · `press` · `scroll` · `drag` · `handle_alert` · `open` · `nav` · `goto` · `ask` · `search` · `toggle` · `note` · `batch` · `skill` · `atlas`",
          },
          { type: "code", language: "bash", code: "phone-use goto --help" },
        ],
      },
      {
        title: "Output behavior",
        blocks: [
          {
            type: "paragraph",
            text: "Output is styled in a TTY and becomes plain text when piped. `NO_COLOR` also disables styling.",
          },
        ],
      },
    ],
  },
  {
    slug: "reference/environment",
    title: "Environment variables",
    description: "Configure device selection, agent access, persistence, and terminal output.",
    eyebrow: "Reference",
    sections: [
      {
        title: "Variables",
        blocks: [
          {
            type: "table",
            headers: ["Variable", "Purpose"],
            rows: [
              ["PHONE_USE_DEVICE", "launch, connect, a simulator UDID, or android (adb)"],
              ["PHONE_USE_DEVICES", "Several named phones for one MCP server, e.g. a=<udid>,b=android:<serial>"],
              ["PHONE_USE_CLOUD_URL", "Control-plane URL (set by phone-use login)"],
              ["PHONE_USE_CLOUD_TOKEN", "API key for cloud phones (set by phone-use login)"],
              ["PHONE_USE_SANDBOX_URL", "A cloud phone's endpoint — routes every verb to it"],
              ["PHONE_USE_SANDBOX_TOKEN", "That phone's session token"],
              ["ANTHROPIC_API_KEY", "Built-in task loop and embedded sessions"],
              ["PHONE_USE_MODE", "observe, default, or auto"],
              ["PHONE_USE_MODEL", "Built-in agent model"],
              ["PHONE_USE_MAX_STEPS", "Maximum agent iterations"],
              ["PHONE_USE_NOTES", "Scratchpad persistence file"],
              ["PHONE_USE_MAP_DIR", "App-map directory"],
              ["PHONE_USE_SKILL_DIR", "Compiled-skill directory"],
              ["PHONE_USE_TRACE_MODE", "on, on-failure, or off when unset"],
              ["PHONE_USE_TRACE_OUT", "Portable trace zip destination"],
              ["PHONE_USE_LIVE_PORT", "Viewer port; defaults to 4936"],
              ["NO_COLOR", "Disable terminal styling"],
            ],
          },
        ],
      },
      {
        title: "Traces",
        blocks: [
          {
            type: "code",
            language: "bash",
            code: 'export PHONE_USE_TRACE_MODE="on-failure"\nexport PHONE_USE_TRACE_OUT="$PWD/phone-use-trace.zip"',
          },
        ],
      },
    ],
  },
  {
    slug: "reference/errors",
    title: "SDK errors",
    description: "Stable error codes and retry guidance for infrastructure failures.",
    eyebrow: "Reference",
    sections: [
      {
        title: "Error codes",
        blocks: [
          {
            type: "table",
            headers: ["Error", "Code", "Retryable"],
            rows: [
              ["DeviceNotFoundError", "DEVICE_NOT_FOUND", "No"],
              ["DeviceInUseError", "DEVICE_IN_USE", "Yes"],
              ["SessionNotFoundError", "SESSION_NOT_FOUND", "No"],
              ["TimeoutError", "TIMEOUT", "Yes"],
              ["ActionFailedError", "ACTION_FAILED", "Yes"],
              ["UnsupportedCapabilityError", "UNSUPPORTED_CAPABILITY", "No"],
              ["AbortedError", "ABORTED", "No"],
            ],
          },
        ],
      },
      {
        title: "Handle infrastructure errors",
        blocks: [
          {
            type: "code",
            language: "ts",
            code: 'try {\n  const device = await ios.connect();\n} catch (error) {\n  if (error instanceof PhoneUseError) {\n    console.error(error.code, error.retryable, error.message);\n  }\n}',
          },
          {
            type: "callout",
            text: "Action-level timeouts normally return `{ success: false, code: \"TIMEOUT\" }`. They are not thrown.",
          },
        ],
      },
    ],
  },
  {
    slug: "cloud/overview",
    title: "Phone Use Cloud",
    description: "Cloud iOS and Android phones your agents can see, drive and verify. On a waitlist for now.",
    eyebrow: "Cloud",
    sections: [
      {
        title: "What it is",
        blocks: [
          {
            type: "callout",
            tone: "warning",
            text: "Cloud phones are on a waitlist: join at https://phoneuse.dev/waitlist. Until your account is approved, `phone-use create` creates nothing and tells you how to continue on the local simulator, which is free and needs no account.",
          },
          {
            type: "paragraph",
            text: "Phone Use Cloud provisions iOS simulators on managed Mac hardware and Android emulators on Linux hosts, and hands them to agents through the same verbs as local devices. An iOS phone starts in about two seconds from a pre-booted image. Phones are billed per minute and close when you are done, or on their own after 15 minutes idle.",
          },
          {
            type: "list",
            items: [
              "Console at app.phoneuse.dev: create phones, watch them (live video on iOS, screenshots on Android), mint API keys, track usage",
              "CLI: phone-use login, create, env, close, install",
              "Any MCP client: paste one .mcp.json block and every phone tool drives the cloud phone",
              "SDK: CloudSandboxBackend implements DeviceBackend, so agents cannot tell cloud from local",
            ],
          },
          {
            type: "callout",
            text: "Simulators and emulators cannot run App Store apps or pass device attestation. Bring your own iOS build with `phone-use install`: good for verification loops, QA and agent training, not for live consumer accounts.",
          },
        ],
      },
    ],
  },
  {
    slug: "cloud/quickstart",
    title: "Cloud quickstart",
    description: "From sign-in to a cloud phone your agent is driving, once your account is approved.",
    eyebrow: "Cloud",
    sections: [
      {
        title: "From zero to a driven phone",
        blocks: [
          {
            type: "callout",
            tone: "warning",
            text: "Cloud phones are on a waitlist: join at https://phoneuse.dev/waitlist. These steps work for an approved account. For everyone else `phone-use create` exits non-zero and prints the local alternative; the Quickstart covers it.",
          },
          {
            type: "steps",
            items: [
              {
                title: "Sign in",
                text: "Opens the console in your browser; approve the CLI and a key lands in `~/.phone-use/config.json`. On a machine with no browser (SSH, Docker, CI) it prints a short code to approve at app.phoneuse.dev/device instead; force that with `--device`.",
                code: "phone-use login",
              },
              {
                title: "Create a phone",
                text: "An iOS phone comes from a warm pool and is running in about two seconds. `phone-use create android` works the same way.",
                code: "phone-use create ios",
              },
              {
                title: "Attach your shell",
                text: "Exports the phone's endpoint and session token so every verb targets it.",
                code: 'eval "$(phone-use env sbx_YOUR_ID)"',
              },
              {
                title: "Drive it",
                text: "Any registry verb, or the built-in agent loop.",
                code: 'phone-use observe\nphone-use task "open Settings and report the iOS version"',
              },
              {
                title: "Ship your app onto it",
                text: "Uploads and installs a local iOS simulator build.",
                code: "phone-use install ./build/MyApp.app",
              },
              {
                title: "Close it",
                text: "Or walk away: a phone closes itself after 15 minutes idle, and billing stops when it closes.",
                code: "phone-use close sbx_YOUR_ID",
              },
            ],
          },
        ],
      },
      {
        title: "Watch it live",
        blocks: [
          {
            type: "paragraph",
            text: "Open the console and select the phone. iOS phones stream live video you can tap along with; Android phones show screenshots for now.",
          },
        ],
      },
    ],
  },
  {
    slug: "cloud/connect-agents",
    title: "Connect agents",
    description: "Hand a cloud phone to Claude Code, Cursor, the SDK, or any shell.",
    eyebrow: "Cloud",
    sections: [
      {
        title: "Claude Code / Cursor (MCP)",
        blocks: [
          {
            type: "paragraph",
            text: "The console's Connect panel prints this ready to copy for each phone:",
          },
          {
            type: "code",
            language: "json",
            code: '{\n  "mcpServers": {\n    "phone-use": {\n      "command": "npx",\n      "args": ["-y", "phone-use", "mcp"],\n      "env": {\n        "PHONE_USE_SANDBOX_URL": "<endpoint>",\n        "PHONE_USE_SANDBOX_TOKEN": "<token>"\n      }\n    }\n  }\n}',
          },
        ],
      },
      {
        title: "Shell / CI",
        blocks: [
          {
            type: "code",
            language: "bash",
            code: 'eval "$(phone-use env sbx_YOUR_ID)"\nphone-use tap "Sign up"',
          },
        ],
      },
      {
        title: "SDK",
        blocks: [
          {
            type: "code",
            language: "ts",
            code: 'import { createCloudSandboxBackend } from "@phone-use/sdk";\n\nconst backend = createCloudSandboxBackend({\n  endpoint: process.env.PHONE_USE_SANDBOX_URL!,\n  token: process.env.PHONE_USE_SANDBOX_TOKEN!,\n});',
          },
          {
            type: "callout",
            text: "The session token dies when the phone closes. Treat it like a temporary credential; the account API key never leaves your machine.",
          },
        ],
      },
    ],
  },
  {
    slug: "cloud/api",
    title: "Cloud API",
    description: "REST surface of the control plane at api.phoneuse.dev.",
    eyebrow: "Cloud",
    sections: [
      {
        title: "Authentication",
        blocks: [
          {
            type: "paragraph",
            text: "Two credential planes: browser sessions (email/password or Google, cookie-based) for the console, and bearer API keys for agents and the CLI. Keys are minted in the console or via POST /v1/keys/rotate and stored hashed.",
          },
        ],
      },
      {
        title: "Endpoints",
        blocks: [
          {
            type: "table",
            headers: ["Method + path", "Purpose"],
            rows: [
              ["POST /v1/sandboxes", "Create a phone ({ platform, ttlMs?, idleTimeoutMs? })"],
              ["GET /v1/sandboxes", "List your phones"],
              ["GET /v1/sandboxes/:id", "One phone, including connection { endpoint, token }"],
              ["DELETE /v1/sandboxes/:id", "Close a phone"],
              ["GET /v1/usage", "Billing ledger (per-minute, written at close)"],
              ["POST /v1/keys/rotate", "Mint a fresh API key (invalidates the previous)"],
              ["GET /v1/me", "Who am I, including cloudApproved"],
              ["POST /v1/waitlist", "Join the waitlist ({ email, useCase? }); needs no key"],
            ],
          },
          {
            type: "paragraph",
            text: "Cloud phones are on a waitlist. POST /v1/sandboxes from an account that is not approved creates nothing and answers HTTP 403 with `{ \"code\": \"cloud_waitlist\", \"waitlistUrl\": \"…\", \"error\": \"…\" }`. Branch on `code`. The CLI, the MCP server and the SDK turn it into one message that names the local device to use instead.",
          },
          {
            type: "code",
            language: "bash",
            code: 'curl -s https://api.phoneuse.dev/v1/sandboxes \\\n  -H "Authorization: Bearer $PHONE_USE_CLOUD_TOKEN" \\\n  -H "content-type: application/json" \\\n  -d \'{"platform":"ios"}\'',
          },
        ],
      },
      {
        title: "Device RPC and live stream",
        blocks: [
          {
            type: "paragraph",
            text: "Each running phone exposes POST <endpoint>/rpc (verbs: snapshot, press, fill, scroll, pan, installApp, …) authorized by its session token, and a WebSocket at <endpoint>/stream?token=… pushing JPEG frames for live view.",
          },
        ],
      },
    ],
  },
  {
    slug: "benchmark/iosworld",
    title: "iOSWorld results",
    description: "How Phone Use scores on the official 133-task iOSWorld benchmark.",
    eyebrow: "Benchmark",
    sections: [
      {
        title: "Headline results",
        blocks: [
          {
            type: "paragraph",
            text: "Phone Use was evaluated on the official iOSWorld suite: 133 tasks across 26 SwiftUI apps, scored by the benchmark's unmodified GPT judge. A task passes only when every rubric criterion is satisfied. The run uses Claude Opus 4.6 — the same model as the published best — driving the Phone Use CLI.",
          },
          {
            type: "table",
            headers: ["Category", "Phone Use", "Published best (vision + XML)"],
            rows: [
              ["Single-app", "25/27 · 92.6%", "81.5%"],
              ["Memory", "25/46 · 54.3%", "54.3%"],
              ["Multi-app", "20/60 · 33.3%", "36.7%"],
              ["Overall", "70/133 · 52.6%", "51.9%"],
            ],
          },
          {
            type: "callout",
            text: "Best result per task across attempts; the campaign and per-task evidence — judge criteria, agent reports, action traces, and final frames — are published at /benchmark.",
          },
        ],
      },
      {
        title: "Methodology",
        blocks: [
          {
            type: "list",
            items: [
              "Official tasks.json, app suite, and state-reset protocol; artifacts follow the benchmark schema.",
              "Unmodified judge (GPT, strict all-criteria pass), run with the benchmark's own judge_trajectories.py.",
              "50-step budget matching the reference semantics: one step = one model generation, executing any number of device actions.",
              "Best-of-N across attempts per task, disclosed; every attempt's artifacts are preserved.",
              "Agent surface: Phone Use CLI over the accessibility tree, with selective screenshot reads (0–8 per task) instead of every-step vision.",
            ],
          },
        ],
      },
      {
        title: "Tiered perception",
        blocks: [
          {
            type: "paragraph",
            text: "The agent reads the compressed accessibility tree by default and looks at pixels only at decision points where text is insufficient — proof screens, pickers, visual layouts. That keeps the speed and cost of a text agent with the ceiling of a vision agent: measured $2.53 median per task and ~10 minutes median end-to-end, with simple tasks completing in about a minute for roughly $0.25.",
          },
        ],
      },
    ],
  },
  {
    slug: "benchmark/demo",
    title: "Live demo runbook",
    description: "Reproduce the two-app money-and-message demo on your own simulator.",
    eyebrow: "Benchmark",
    sections: [
      {
        title: "The hero demo",
        blocks: [
          {
            type: "paragraph",
            text: "One natural-language instruction, two apps, about 90 seconds, uncut: the agent sends money in a banking app (with a memo), then reports it in a messaging app — while the permission layer visibly gates the irreversible send until the goal authorizes it.",
          },
          {
            type: "steps",
            items: [
              {
                title: "Stage a clean simulator",
                text: "Boot an iPhone simulator with the demo apps installed and reset their state so the run starts fresh.",
                code: "open -a Simulator",
              },
              {
                title: "Start recording",
                text: "Record your screen with the terminal and the simulator side by side (QuickTime → New Screen Recording, or ⌘⇧5). Uncut runs are the proof.",
              },
              {
                title: "Run the goal",
                text: "Hand the instruction to any agent connected to Phone Use — Claude Code shown here.",
                code: 'claude -p "Send $50 to Maya Patel on MyBank with the memo \'dinner\', then message Maya on QuickChat that the money is on the way. Confirm both are visible on screen." \\\n  --allowedTools "Bash(bun:*)"',
              },
              {
                title: "Show the replay",
                text: "Run the same goal again: known routes replay from the app map with far fewer model calls. Same result, a fraction of the time — that is the memory story in one take.",
              },
            ],
          },
          {
            type: "callout",
            text: "Destructive steps (send, pay, delete) refuse on first attempt and require --yes. Leaving that moment in the recording demonstrates the permission pipeline better than any slide.",
          },
        ],
      },
    ],
  },
];

export const docsBySlug = new Map(pages.map((page) => [page.slug, page]));
export const orderedDocs = pages;

export const docGroups = [
  {
    title: "Start",
    pages: ["introduction", "quickstart", "installation"],
  },
  {
    title: "Cloud",
    pages: ["cloud/overview", "cloud/quickstart", "cloud/connect-agents", "cloud/api"],
  },
  {
    title: "Use Phone Use",
    pages: ["guides/cli", "guides/mcp", "guides/agent-sessions"],
  },
  {
    title: "Core concepts",
    pages: [
      "concepts/runtime",
      "concepts/observe",
      "concepts/verification",
      "concepts/app-maps",
      "concepts/skills",
      "concepts/permissions",
    ],
  },
  {
    title: "TypeScript SDK",
    pages: ["sdk/overview", "sdk/device-lifecycle", "sdk/observe-and-act", "sdk/testing"],
  },
  {
    title: "Benchmark",
    pages: ["benchmark/iosworld", "benchmark/demo"],
  },
  {
    title: "Reference",
    pages: ["reference/cli", "reference/environment", "reference/errors"],
  },
] as const;

export function docHref(slug: string) {
  return slug === "introduction" ? "/docs" : `/docs/${slug}`;
}
