"use client";

// The sidebar: your phones (the main navigation), then Usage, API key, Docs
// and the account. At 960 px and below it becomes a top bar; labels go
// visually hidden, never away.

import type { ReactNode } from "react";
import type { Platform, Tone } from "../../lib/console";
import { Icon } from "./ui";

export type Section = "phones" | "keys" | "usage";

export type SidebarPhone = {
  id: string;
  platform: string;
  name: string;
  /** A few characters of the id, enough to tell two iPhones apart. */
  short: string;
  word: string;
  tone: Tone;
  thumb: ReactNode;
  booting: boolean;
};

export type CreateFailure = { platform: Platform; message: string };

export const platformNoun = (p: Platform): string => (p === "android" ? "Android phone" : "iPhone");

export function Sidebar({
  section,
  onSection,
  phones,
  loaded,
  selectedId,
  onSelect,
  androidCloud,
  canCreate = true,
  creating,
  onCreate,
  createFailure,
  onDismissFailure,
  who,
  dark,
  onToggleTheme,
  onSignOut,
}: {
  section: Section;
  onSection: (s: Section) => void;
  phones: SidebarPhone[];
  loaded: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  androidCloud: boolean;
  /** False while the account is on the cloud waitlist: no create buttons to press and be refused. */
  canCreate?: boolean;
  creating: Platform | null;
  onCreate: (p: Platform) => void;
  createFailure: CreateFailure | null;
  onDismissFailure: () => void;
  who: string;
  dark: boolean;
  onToggleTheme: () => void;
  onSignOut: () => void;
}) {
  const platforms: Platform[] = !canCreate ? [] : androidCloud ? ["ios", "android"] : ["ios"];
  return (
    <aside className="dash-side" aria-label="Console">
      <a className="logo dash-side-logo" href="https://www.phoneuse.dev">
        <span className="logo-mark" aria-hidden="true">
          <i />
        </span>
        <span className="dash-hide-narrow">phone-use</span>
      </a>

      <nav className="dash-phones" aria-label="Phones">
        <div className="dash-phones-head">
          <button
            type="button"
            className="dash-phones-title"
            aria-current={section === "phones" ? "page" : undefined}
            onClick={() => onSection("phones")}
          >
            Phones
          </button>
        </div>

        {phones.length > 0 ? (
          <ul className="dash-plist">
            {phones.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="dash-prow"
                  aria-current={p.id === selectedId ? "true" : undefined}
                  onClick={() => onSelect(p.id)}
                >
                  <span
                    className={`dash-thumb${p.platform === "android" ? " is-android" : ""}${p.booting ? " is-booting" : ""}`}
                    aria-hidden="true"
                  >
                    {p.booting ? <i /> : p.thumb}
                  </span>
                  <span className="dash-prow-text">
                    <span className="dash-prow-name">
                      {p.name} <span className="dash-prow-id">{p.short}</span>
                    </span>
                    <span className={`dash-prow-state is-${p.tone}`}>{p.word}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          loaded && <p className="dash-plist-empty">{canCreate ? "No phones running." : "Cloud phones: on the waitlist."}</p>
        )}

        <div className="dash-create">
          {platforms.map((p) => (
            <button key={p} type="button" className="dash-ghost" disabled={creating !== null} onClick={() => onCreate(p)}>
              {Icon.plus}
              {creating === p ? (
                "Starting…"
              ) : (
                <span>
                  <span className="dash-hide-narrow">New </span>
                  {p === "android" ? "Android" : "iPhone"}
                  {p === "android" && <span className="dash-hide-narrow"> phone</span>}
                </span>
              )}
            </button>
          ))}
        </div>

        {createFailure && (
          <div className="dash-failed" role="alert">
            <p>
              Couldn’t start {createFailure.platform === "android" ? "an Android phone" : "an iPhone"}. {createFailure.message}
            </p>
            <span className="dash-row">
              <button type="button" className="dash-btn2 is-sm" onClick={() => onCreate(createFailure.platform)} disabled={creating !== null}>
                Try again
              </button>
              <button type="button" className="dash-ghost is-sm" onClick={onDismissFailure}>
                Dismiss
              </button>
            </span>
          </div>
        )}
      </nav>

      <div className="dash-side-foot">
        <div className="dash-side-links">
          <button type="button" className="dash-ghost" aria-current={section === "usage" ? "page" : undefined} onClick={() => onSection("usage")}>
            Usage
          </button>
          <button type="button" className="dash-ghost" aria-current={section === "keys" ? "page" : undefined} onClick={() => onSection("keys")}>
            API key
          </button>
          <a className="dash-ghost" href="https://www.phoneuse.dev/docs">
            Docs
          </a>
        </div>
        <div className="dash-user">
          <span className="dash-user-name">{who}</span>
          <button
            type="button"
            className="dash-iconbtn"
            aria-label={dark ? "Use light theme" : "Use dark theme"}
            title={dark ? "Light theme" : "Dark theme"}
            onClick={onToggleTheme}
          >
            {dark ? Icon.sun : Icon.moon}
          </button>
          <button type="button" className="dash-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
