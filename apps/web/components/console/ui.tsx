"use client";

// Small shared pieces: the few icons the console uses (inline stroke SVG,
// 15px, 1.4 stroke, currentColor; no icon packages) and the copy button.

import { type ReactNode, useEffect, useState } from "react";

const svg = (children: ReactNode) => (
  <svg className="dash-ico" viewBox="0 0 16 16" aria-hidden="true">
    {children}
  </svg>
);

export const Icon = {
  plus: svg(<path d="M8 3.5v9M3.5 8h9" />),
  copy: svg(
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </>,
  ),
  close: svg(<path d="M4 4l8 8M12 4l-8 8" />),
  sun: svg(
    <>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" />
    </>,
  ),
  moon: svg(<path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6Z" />),
};

/** Every secret and snippet gets one. The label flips to "Copied" for 1.6 s. */
export function CopyButton({
  text,
  label = "Copy",
  className = "dash-btn2 is-sm",
  ariaLabel,
}: {
  text: string;
  label?: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied && !failed) return;
    const t = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1600);
    return () => clearTimeout(t);
  }, [copied, failed]);
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => setFailed(true),
        );
      }}
    >
      <span aria-live="polite">{copied ? "Copied" : failed ? "Copy failed" : label}</span>
    </button>
  );
}
