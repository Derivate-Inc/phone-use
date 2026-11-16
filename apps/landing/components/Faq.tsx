// FAQ content. Answers are plain strings so the same text feeds the visible
// list and the FAQPage structured data; `code` spans are written in
// backticks and rendered as <code>.

export const FAQS = [
  {
    q: "What is Phone Use?",
    a: "An open-source CLI, MCP server and SDK that gives AI agents phones to work on. One command creates an iOS simulator or an Android emulator in the cloud. Your agent drives it with the same verbs on both, like `observe`, `tap`, `type`, `goto` and `ask`, and each action reports whether the screen changed.",
  },
  {
    q: "Which agents can use it?",
    a: "Any MCP client, including Claude Code, Codex and Cursor, and any agent that can run shell commands. The CLI also has a built-in agent: run `phone-use task \"…\"` with an Anthropic API key.",
  },
  {
    q: "What do I need to install?",
    a: "One command on macOS or Linux: `curl -fsSL https://phoneuse.dev/install | bash`. It installs Bun, which the CLI runs on, if it isn’t there yet. Run `phone-use doctor` to check your setup.",
  },
  {
    q: "Do I need a Mac?",
    a: "Not for cloud phones. They run on our hardware and the CLI reaches them over the network. You only need a Mac with Xcode to run an iOS simulator on your own machine.",
  },
  {
    q: "How long does a phone last?",
    a: "One hour by default, up to 24 hours with `--ttl`. A phone closes itself after 15 minutes with no activity; change that with `--idle`, or pass `--idle off`. Close one any time with `phone-use close <id>`.",
  },
  {
    q: "How is it billed?",
    a: "By the minute, for as long as a phone is running, from create to close. The console shows your usage.",
  },
  {
    q: "Can I watch my agent work?",
    a: "Yes. `phone-use create` prints a link to the phone in the console. iOS phones stream live video and you can tap along from the browser. Android phones show screenshots for now.",
  },
  {
    q: "Can I test my own app?",
    a: "On iOS, yes: `phone-use install ./MyApp.app` uploads a simulator build to the phone. These are simulators and emulators, not physical phones, so App Store apps and accounts that require a real device will not work.",
  },
  {
    q: "How are phones secured?",
    a: "Each phone gets its own endpoint and a session token that dies when the phone closes. Your account API key stays on your machine.",
  },
  {
    q: "Can I run it without the cloud?",
    a: "Yes. With no cloud phone attached, the CLI drives a local iOS simulator (macOS with Xcode) or an Android emulator over adb.",
  },
] as const;

export function renderAnswer(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part,
  );
}

// FAQPage structured data for the questions a page shows, safe to inline in
// a <script type="application/ld+json"> (no closing-tag sequences survive)
export function faqJsonLd(items: readonly { q: string; a: string }[]) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a.replaceAll("`", "") },
    })),
  }).replace(/</g, "\\u003c");
}
