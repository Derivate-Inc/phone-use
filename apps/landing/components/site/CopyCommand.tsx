"use client";

import { useEffect, useRef, useState } from "react";

// The install command is the call to action: the command sits in a well, with a
// "copy" segment on the right. Clicking anywhere on it copies the command.
export default function CopyCommand({ cmd = "curl -fsSL https://phoneuse.dev/install | bash" }: { cmd?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      // Clipboard unavailable (permissions, http): the command stays readable.
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button type="button" className="site-cmd" onClick={copy} aria-label={`Copy: ${cmd}`}>
      <span className="site-cmd-text">{cmd}</span>
      {/* Both labels share one grid cell, so the segment never changes width */}
      <span className="site-cmd-copy" data-copied={copied || undefined} aria-hidden>
        <span>copy</span>
        <span>copied</span>
      </span>
      <span className="sr-only" aria-live="polite">{copied ? "Copied" : ""}</span>
    </button>
  );
}
