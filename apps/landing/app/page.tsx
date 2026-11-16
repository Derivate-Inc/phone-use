import type { Metadata } from "next";
import Link from "next/link";
import { FAQS, faqJsonLd, renderAnswer } from "@/components/Faq";
import { ChartNoAxesColumn, KeyRound, MousePointerClick, Repeat2, Route, ScanEye, Waypoints } from "lucide-react";
import { AgentsDemo, GotoDemo, ObserveDemo, SkillDemo, TapDemo } from "@/components/stageshow/Capabilities";
import PhoneWall from "@/components/stageshow/PhoneWall";
import PhoneUseHero from "@/components/stageshow/PhoneUseHero";
import CopyCommand from "@/components/site/CopyCommand";
import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import "@/components/site/site.css";
import { fontVariables } from "./fonts";
import "./home.css";

// The homepage. Shell (nav, footer, fonts, tokens) is components/site; the
// product pictures are stageshow scenes in components/stageshow.


export const metadata: Metadata = {
  title: "Phone Use · Give your agent a phone",
  description:
    "One open-source CLI drives the iOS Simulator on your Mac or an Android device over adb, free and with no account. Your agent reads the screen as named elements and is told whether each action worked. Cloud phones are on a waitlist.",
};


// The questions a developer asks before trying it; the rest live in the docs
const QUESTIONS = [
  "Which agents can use it?",
  "Is it free?",
  "Do I need a Mac?",
  "How do I get a cloud phone?",
  "Can I test my own app?",
  "Can I watch my agent work?",
];
const FAQ = QUESTIONS.map((q) => FAQS.find((f) => f.q === q)!).filter(Boolean);

// An agent's mark alone, drawn in one colour from its own artwork so four
// brands share one weight; the name is its label and tooltip
function Agent({ logo, name }: { logo: string; name: string }) {
  return (
    <span
      className="home-agent"
      role="img"
      aria-label={name}
      title={name}
      style={{ ["--mark" as string]: `url(/logos/${logo}.svg)` }}
    />
  );
}

export default function Home() {
  return (
    <div className={`site home ${fontVariables}`}>
      <SiteNav />

      <main>
        <section className="home-hero">
          <div className="site-wrap home-hero-copy">
            <h1>Give your agent a phone</h1>
            <p className="site-lede">A free, open-source CLI for the iOS Simulator and Android.</p>
            <div className="home-actions">
              <CopyCommand />
            </div>
            <p className="home-waitlist">
              Cloud phones are on a waitlist. <Link href="/waitlist">Join it</Link>
            </p>
            <p className="home-works">
              <span>Works with</span>
              <Agent logo="anthropic" name="Claude Code" />
              <Agent logo="codex" name="Codex" />
              <Agent logo="cursor" name="Cursor" />
              <Agent logo="mcp" name="Any MCP client" />
            </p>
          </div>

          <div className="site-wrap home-stage">
            <PhoneUseHero />
          </div>
        </section>

        <section className="home-section" id="capabilities">
          <div className="site-wrap">
            <div className="home-heading">
              <h2>Your agent knows what it’s tapping</h2>
              <p>
                It works from the structure of the screen, hears back after every
                action and learns the way around an app as it goes.
              </p>
            </div>

            <div className="home-bento-frame">
              <span className="home-mark" data-at="tl" aria-hidden />
              <span className="home-mark" data-at="tr" aria-hidden />
              <span className="home-mark" data-at="bl" aria-hidden />
              <span className="home-mark" data-at="br" aria-hidden />
              <div className="home-bento">
                <article className="home-cell home-cell-wide">
                  <div className="home-cell-copy">
                    <h3><ScanEye size={16} strokeWidth={1.75} aria-hidden />What your agent sees</h3>
                    <p>
                      <code>observe</code> returns <strong>every element on screen</strong> with
                      its label, role and position, so the agent acts on names, not pixels.
                    </p>
                  </div>
                  <div className="home-cell-pic">
                    <ObserveDemo />
                  </div>
                </article>

                <Link href="/benchmark" className="home-cell home-cell-stat">
                  <div className="home-cell-copy">
                    <h3><ChartNoAxesColumn size={16} strokeWidth={1.75} aria-hidden />iOSWorld</h3>
                    <p>
                      An open benchmark of <strong>133 tasks across 26 apps</strong>, judged
                      by its own checks.
                    </p>
                  </div>
                  <div className="home-stat">
                    <strong>52.6%</strong>
                    <span>task success · best published 51.9%</span>
                  </div>
                  <table className="home-stat-table">
                    <thead>
                      <tr>
                        <th scope="col">Tasks</th>
                        <th scope="col">Phone Use</th>
                        <th scope="col">Best published</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th scope="row">Single app</th>
                        <td data-win>92.6</td>
                        <td>81.5</td>
                      </tr>
                      <tr>
                        <th scope="row">Memory</th>
                        <td>54.3</td>
                        <td>54.3</td>
                      </tr>
                      <tr>
                        <th scope="row">Multi-app</th>
                        <td>33.3</td>
                        <td data-win>36.7</td>
                      </tr>
                    </tbody>
                  </table>
                  <span className="home-cell-link">See every task</span>
                </Link>

                <article className="home-cell">
                  <div className="home-cell-copy">
                    <h3><MousePointerClick size={16} strokeWidth={1.75} aria-hidden />Checked taps</h3>
                    <p>
                      Each tap reports <strong>whether the screen changed</strong>, so one
                      that did nothing never passes as done.
                    </p>
                  </div>
                  <div className="home-cell-pic">
                    <TapDemo />
                  </div>
                </article>

                <article className="home-cell">
                  <div className="home-cell-copy">
                    <h3><Route size={16} strokeWidth={1.75} aria-hidden />App maps</h3>
                    <p>
                      Screens and the paths between them are saved, so <code>goto</code>{" "}
                      <strong>needs no model</strong> to get there.
                    </p>
                  </div>
                  <div className="home-cell-pic">
                    <GotoDemo />
                  </div>
                </article>

                <article className="home-cell">
                  <div className="home-cell-copy">
                    <h3><Repeat2 size={16} strokeWidth={1.75} aria-hidden />Skills</h3>
                    <p>
                      Record a task once. Replays run <strong>without a model call</strong>,
                      checking each step.
                    </p>
                  </div>
                  <div className="home-cell-pic">
                    <SkillDemo />
                  </div>
                </article>

                <article className="home-cell home-cell-wide">
                  <div className="home-cell-copy">
                    <h3><Waypoints size={16} strokeWidth={1.75} aria-hidden />Works with your agent</h3>
                    <p>
                      One MCP server gives <strong>any MCP client</strong> the same tools on
                      both platforms. Shell agents call the CLI.
                    </p>
                  </div>
                  <div className="home-cell-pic">
                    <AgentsDemo />
                  </div>
                </article>

                <article className="home-cell home-cell-statement">
                  <div className="home-cell-copy">
                    <h3><KeyRound size={16} strokeWidth={1.75} aria-hidden />Scoped access</h3>
                  </div>
                  <p className="home-statement">
                    Every cloud phone gets its own token, and the token dies when the
                    phone closes.
                  </p>
                  <p className="home-statement-note">Your account key never leaves your machine.</p>
                  <ol className="home-life" aria-label="A phone token's life">
                    <li data-tone="on">
                      <code>create ios</code>
                      <span>token issued</span>
                    </li>
                    <li>
                      <code>close &lt;id&gt;</code>
                      <span>token revoked</span>
                    </li>
                    <li>
                      <code>15 min idle</code>
                      <span>closes itself</span>
                    </li>
                  </ol>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section className="home-section" id="faq">
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: faqJsonLd(FAQ) }} />
          <div className="site-wrap">
            <div className="home-faq-head">
              <h2>Questions</h2>
              <Link href="/docs">Read the docs</Link>
            </div>
            <dl className="home-faq">
              {FAQ.map(({ q, a }) => (
                <div key={q}>
                  <dt>{q}</dt>
                  <dd>{renderAnswer(a)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="home-final">
          <div className="site-wrap home-final-inner">
            <h2>Start on your own machine in a minute</h2>
            <div className="home-actions">
              <CopyCommand />
            </div>
            <p className="home-waitlist">
              Want a cloud phone? <Link href="/waitlist">Join the waitlist</Link>
            </p>
          </div>
          <PhoneWall />
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
