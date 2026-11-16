import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import "@/components/site/site.css";
import { fontVariables } from "../fonts";
import "./benchmark.css";
import results from "./results-data.json";

export const metadata: Metadata = {
  title: "iOSWorld Results and Efficiency | Phone Use",
  description:
    "Phone Use iOSWorld results, published reference scores, reported cost and timing, and scoped harness efficiency experiments with per-task evidence.",
};

const CATEGORIES = [
  { key: "single", label: "Single app", published: 81.5 },
  { key: "multi", label: "Multi-app", published: 36.7 },
  { key: "memory", label: "Memory", published: 54.3 },
] as const;

const PUBLISHED_OVERALL = 51.9;

// Recorded input-token counts (thousands), docs/16-harness-v1-plan.md, July 20, 2026.
// This six-task experiment is separate from the 133-task iOSWorld campaign.
const TOKEN_TASKS = [
  { label: "Read version", raw: 70, harness: 71, passed: true },
  { label: "Deep navigation", raw: 184, harness: 72, passed: true },
  { label: "Search and open", raw: 105, harness: 74, passed: true },
  { label: "Toggle setting", raw: 180, harness: 72, passed: true },
  { label: "Read phone information", raw: 205, harness: 71, passed: true },
  { label: "Create contact", raw: 227, harness: 228, passed: false },
] as const;

function rate(passes: number, total: number) {
  return (passes / total) * 100;
}

function pct(value: number) {
  return `${value.toFixed(1)}%`;
}

type Row = (typeof results.tasks)[number];

function TaskRow({ r }: { r: Row }) {
  return (
    <details className="bm-task" data-passed={r.passed || undefined}>
      <summary>
        <span className="bm-task-n">{r.n}</span>
        <code className="bm-task-id">{r.task}</code>
        <span className="bm-task-crit">{r.criteria}</span>
        <span className="bm-badge" data-tone={r.passed ? "pass" : "partial"}>
          {r.passed ? "Pass" : `${(r.score * 100).toFixed(0)}%`}
        </span>
        <span className="bm-chevron" aria-hidden />
      </summary>
      <div className="bm-task-body">
        <div className="bm-task-main">
          {r.goal ? (
            <p className="bm-goal">
              <strong>Task</strong> {r.goal}
            </p>
          ) : null}
          {r.rubric.length > 0 ? (
            <ul className="bm-rubric">
              {r.rubric.map((c) => (
                <li key={c.c} data-ok={c.ok || undefined}>
                  <span aria-hidden>{c.ok ? "✓" : "✗"}</span>
                  {c.c}
                </li>
              ))}
            </ul>
          ) : null}
          {r.answer ? (
            <p className="bm-answer">
              <strong>Agent report</strong> {r.answer}
              {r.answer.length >= 600 ? "…" : ""}
            </p>
          ) : null}
          {r.steps.length > 0 ? (
            <details className="bm-trace">
              <summary>Trace, {r.steps.length} steps</summary>
              <ol>
                {r.steps.map((s, i) => (
                  <li key={i}>
                    <code>{s}</code>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
        {r.shot ? (
          <figure className="bm-shot">
            <Image src={r.shot} alt={`Final screen for ${r.task}`} width={258} height={560} loading="lazy" unoptimized />
            <figcaption>Final frame</figcaption>
          </figure>
        ) : null}
      </div>
    </details>
  );
}

export default function BenchmarkPage() {
  const total = results.tasks.length;
  const passes = results.tasks.filter((task) => task.passed).length;
  const overall = rate(passes, total);
  const categories = CATEGORIES.map((category) => {
    const rows = results.tasks.filter((task) => task.category === category.key);
    const passed = rows.filter((task) => task.passed).length;
    return { ...category, rows, passes: passed, rate: rate(passed, rows.length) };
  });
  const successfulTasks = TOKEN_TASKS.filter((task) => task.passed);
  const rawTokens = successfulTasks.reduce((sum, task) => sum + task.raw, 0);
  const harnessTokens = successfulTasks.reduce((sum, task) => sum + task.harness, 0);
  const allRawTokens = TOKEN_TASKS.reduce((sum, task) => sum + task.raw, 0);
  const allHarnessTokens = TOKEN_TASKS.reduce((sum, task) => sum + task.harness, 0);
  const tokenReduction = Math.round((1 - harnessTokens / rawTokens) * 100);
  const allTokenReduction = Math.round((1 - allHarnessTokens / allRawTokens) * 100);
  // Bold whichever side leads; a tie stays even
  const lead = (ours: number, theirs: number) => (Math.abs(ours - theirs) < 0.05 ? "tie" : ours > theirs ? "ours" : "theirs");

  return (
    <div className={`site bm ${fontVariables}`}>
      <SiteNav current="benchmark" />

      <main>
        <header className="site-wrap bm-hero">
          <p className="bm-eyebrow">
            <a href="https://iosworld.io/" target="_blank" rel="noreferrer">
              iOSWorld
            </a>{" "}
            · an open benchmark
          </p>
          <h1>Phone Use on iOSWorld</h1>
          <p className="site-lede bm-lede">
            Claude Opus 4.6 driving an iOS simulator through the Phone Use CLI, on {total} tasks across 26 apps.
            A task passes only when the benchmark’s judge marks every criterion met.
          </p>
          <nav className="bm-jump" aria-label="On this page">
            <a href="#comparison">Results</a>
            <a href="#efficiency">Efficiency</a>
            <a href="#tasks">All {total} tasks</a>
            <Link href="/docs/benchmark/iosworld" className="site-link">
              Methodology
            </Link>
          </nav>
        </header>

        <div className="site-wrap">
          <dl className="bm-metrics" aria-label="Campaign summary">
            <div>
              <dt>Task success</dt>
              <dd>{pct(overall)}</dd>
              <p>
                {passes} of {total} tasks, best across attempts
              </p>
            </div>
            <div>
              <dt>Median cost per task</dt>
              <dd>$2.53</dd>
              <p>As reported in the campaign summary</p>
            </div>
            <div>
              <dt>Median time per task</dt>
              <dd>
                ~10<span> min</span>
              </dd>
              <p>End to end, as reported</p>
            </div>
          </dl>
          <p className="bm-note">
            Cost and time are summaries from the{" "}
            <Link href="/docs/benchmark/iosworld#tiered-perception">benchmark docs</Link>. The task archive below
            holds scores and traces, not per-attempt cost or timing.
          </p>
        </div>

        <section id="comparison" className="site-wrap bm-section" aria-labelledby="comparison-heading">
          <div className="bm-heading">
            <h2 id="comparison-heading">Compared with the best published result</h2>
            <p>
              Both runs use Claude Opus 4.6. Phone Use reads a compressed accessibility tree and looks at the screen
              only when it needs to; the published reference uses vision plus XML.
            </p>
          </div>

          <div className="bm-table-wrap" role="region" aria-label="Task success comparison" tabIndex={0}>
            <table className="bm-table">
              <caption className="sr-only">Strict pass rates on the 133-task iOSWorld suite</caption>
              <thead>
                <tr>
                  <th scope="col">Tasks</th>
                  <th scope="col">
                    Phone Use <span>best across attempts</span>
                  </th>
                  <th scope="col">
                    Published Opus 4.6 <span>vision + XML</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr data-overall>
                  <th scope="row">Overall</th>
                  <td data-lead={lead(overall, PUBLISHED_OVERALL) === "ours" || undefined}>
                    {pct(overall)}
                    <small>
                      {passes}/{total}
                    </small>
                  </td>
                  <td data-lead={lead(overall, PUBLISHED_OVERALL) === "theirs" || undefined}>{pct(PUBLISHED_OVERALL)}</td>
                </tr>
                {categories.map((category) => (
                  <tr key={category.key}>
                    <th scope="row">{category.label}</th>
                    <td data-lead={lead(category.rate, category.published) === "ours" || undefined}>
                      {pct(category.rate)}
                      <small>
                        {category.passes}/{category.rows.length}
                      </small>
                    </td>
                    <td data-lead={lead(category.rate, category.published) === "theirs" || undefined}>
                      {pct(category.published)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <aside className="bm-callout">
            <strong>How to read this.</strong> Phone Use reports the best result per task across attempts. Attempt
            counts aren’t in this archive and retry policies weren’t matched, so the published scores are
            context, not a controlled head-to-head.
          </aside>

          <details className="bm-more">
            <summary>Run methodology and what this measures</summary>
            <div>
              <ul>
                <li>Official iOSWorld tasks, 26 SwiftUI apps and the state-reset protocol, as documented for the campaign.</li>
                <li>The benchmark’s own GPT judge, unmodified; a task passes only when every criterion is met.</li>
                <li>A budget of 50 model steps; each step may run several device actions.</li>
                <li>A compressed accessibility tree with selective screenshot reads, reported as 0 to 8 per task.</li>
                <li>Simple tasks took about a minute and $0.25. These are examples, not full-suite medians.</li>
                <li>
                  The cost summary doesn’t say whether judging, infrastructure or retries are included. No matched
                  baseline cost or timing is presented here.
                </li>
              </ul>
              <p>
                iOSWorld measures task completion inside mobile apps. It does not measure app build success or
                regression detection.
              </p>
              <Link href="/docs/benchmark/iosworld" className="site-link">
                Read the campaign documentation
              </Link>
            </div>
          </details>
        </section>

        <section id="efficiency" className="site-wrap bm-section" aria-labelledby="efficiency-heading">
          <div className="bm-heading">
            <h2 id="efficiency-heading">Where the harness saves work</h2>
            <p>
              Two separate experiments, on simple phone tasks and a custom test app. Neither is a
              speed or cost ratio for the iOSWorld suite.
            </p>
          </div>

          <div className="bm-experiments">
            <article>
              <p className="bm-scope">Simple tasks, same model and loop</p>
              <h3>~{tokenReduction}% fewer input tokens</h3>
              <p>
                On the five tasks both configurations completed, the full harness used about {harnessTokens}k input
                tokens against {rawTokens}k with raw controls. Both passed 5 of 6.
              </p>
              <dl className="bm-pair">
                <div>
                  <dt>Raw controls</dt>
                  <dd>{rawTokens}k</dd>
                </div>
                <div data-lead>
                  <dt>Phone Use</dt>
                  <dd>{harnessTokens}k</dd>
                </div>
              </dl>
              <p className="bm-fine">
                Including the failed contact task: {allHarnessTokens}k against {allRawTokens}k, about{" "}
                {allTokenReduction}% lower. Fewer input tokens doesn’t by itself mean lower cost.
              </p>
              <details className="bm-more">
                <summary>All 6 tasks and the setup</summary>
                <div>
                  <p>
                    Same Opus model, loop, tasks and prompts. Raw controls expose observe, tap, type, scroll, open and
                    navigation; the full harness adds intent, map and skill tools. Counts are rounded input tokens,
                    cached input included.
                  </p>
                  <div className="bm-table-wrap" role="region" aria-label="Input tokens by task" tabIndex={0}>
                    <table className="bm-table bm-table-sm">
                      <caption className="sr-only">Six-task input-token comparison, including failures</caption>
                      <thead>
                        <tr>
                          <th scope="col">Task</th>
                          <th scope="col">Raw</th>
                          <th scope="col">Phone Use</th>
                        </tr>
                      </thead>
                      <tbody>
                        {TOKEN_TASKS.map((task) => (
                          <tr key={task.label}>
                            <th scope="row">
                              {task.label}
                              {!task.passed && <small>Failed in both</small>}
                            </th>
                            <td>{task.raw}k</td>
                            <td>{task.harness}k</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p>Source: harness experiment notes.</p>
                </div>
              </details>
            </article>

            <article>
              <p className="bm-scope">A learned workflow, replay only</p>
              <h3>~6× faster replay</h3>
              <p>
                A learned deep-toggle workflow in the Labyrinth test app replayed in about 7.3 seconds with zero model
                calls. The raw agent took 46 seconds.
              </p>
              <dl className="bm-pair">
                <div>
                  <dt>Raw agent</dt>
                  <dd>46 s</dd>
                </div>
                <div data-lead>
                  <dt>Learned skill</dt>
                  <dd>~7.3 s</dd>
                </div>
              </dl>
              <p className="bm-fine">
                One workflow, after learning; the cost and time of learning it are excluded. Zero model calls means no
                inference during replay; the device still costs time.
              </p>
              <details className="bm-more">
                <summary>Replay setup and measurements</summary>
                <div>
                  <p>
                    Five replays: 7.5 seconds for the first, about 7.3 for each of the next four. The raw Opus 4.8
                    agent was measured once, at 46 seconds and about 209k input tokens; any five-run raw total extrapolates
                    from that one run.
                  </p>
                  <p>This measures reuse of a learned workflow, not an improvement on an unfamiliar task.</p>
                  <p>Source: Labyrinth replay experiment notes.</p>
                </div>
              </details>
            </article>
          </div>
        </section>

        <section id="tasks" className="site-wrap bm-section" aria-labelledby="tasks-heading">
          <div className="bm-heading bm-heading-row">
            <div>
              <h2 id="tasks-heading">Every task, including the misses</h2>
              <p>
                Open a task for the judge’s criteria, the agent’s report, its action trace and the final
                frame. A partial score counts criteria met; it is not a pass.
              </p>
            </div>
            <span className="bm-count">
              {passes} of {total} passed
            </span>
          </div>

          {categories.map((category) => (
            <section className="bm-group" key={category.key} aria-labelledby={`tasks-${category.key}`}>
              <header>
                <h3 id={`tasks-${category.key}`}>{category.label}</h3>
                <span>
                  {category.passes} of {category.rows.length} passed · {pct(category.rate)}
                </span>
              </header>
              <div className="bm-list">
                {category.rows.map((row) => (
                  <TaskRow key={row.task} r={row} />
                ))}
              </div>
            </section>
          ))}
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
