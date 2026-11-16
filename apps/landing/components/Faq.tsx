// FAQ content. Answers are plain strings so the same text feeds the visible
// list and the FAQPage structured data; `code` spans are written in
// backticks and rendered as <code>.

export const FAQS = [
  {
    q: "What is Phone Use?",
    a: "An open-source CLI, MCP server and SDK that lets AI agents work on a phone: the iOS Simulator on your Mac, or an Android device or emulator over adb. It is free and needs no account. Your agent drives it with the same verbs on both, like `observe`, `tap`, `type`, `goto` and `ask`, and each action reports whether the screen changed. Cloud phones, which run on our hardware, are on a waitlist.",
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
    q: "Is it free?",
    a: "On your own machine, yes. The CLI, MCP server and SDK are open source, and they need no account. Cloud phones run on our hardware and are on a waitlist.",
  },
  {
    q: "Do I need a Mac?",
    a: "For iOS on your own machine, yes: a Mac with Xcode. Android works over adb on macOS and Linux. Cloud phones need no Mac, and they are on a waitlist.",
  },
  {
    q: "How do I get a cloud phone?",
    a: "Join the waitlist at phoneuse.dev/waitlist and tell us what you would use one for. Until your account is approved, `phone-use create` creates nothing and tells you how to continue on your own machine.",
  },
  {
    q: "How long does a phone last?",
    a: "A cloud phone lasts one hour by default, up to 24 hours with `--ttl`. It closes itself after 15 minutes with no activity; change that with `--idle`, or pass `--idle off`. Close one any time with `phone-use close <id>`.",
  },
  {
    q: "How is it billed?",
    a: "Nothing on your own machine is billed. Cloud phones are metered by the minute, from create to close, and the console shows your usage.",
  },
  {
    q: "Can I watch my agent work?",
    a: "Yes. The MCP server opens a live viewer at `localhost:4936` that shows the phone's screen and where your agent taps. Cloud phones also stream to the console, with live video on iOS.",
  },
  {
    q: "Can I test my own app?",
    a: "Yes. On your own iOS Simulator, `phone-use sim install ./MyApp.app` installs a simulator build. On a cloud phone, `phone-use install ./MyApp.app` uploads it. These are simulators and emulators, not physical phones, so App Store apps and accounts that require a real device will not work.",
  },
  {
    q: "How are phones secured?",
    a: "Each cloud phone gets its own endpoint and a session token that dies when the phone closes. Your account API key stays on your machine.",
  },
  {
    q: "Can I run it without the cloud?",
    a: "Yes, and that is the default. With no cloud phone attached, the CLI drives the iOS Simulator on a Mac with Xcode, or an Android device or emulator over adb. No account is needed.",
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
