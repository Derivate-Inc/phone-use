// Shared types for the device-layer eval (docs/43-device-layer-eval.md).

/** What the tool told the agent about one call. Recorded, never trusted. */
export type ClaimStatus =
  | 'ok' // reported success
  | 'uncertain' // reported success but hedged ("screen did NOT change", "could not read back")
  | 'error' // reported failure
  | 'refused' // declined before acting (blocked, target not offered)
  | 'unsupported' // the tool has no documented way to do this
  | 'hang' // no answer within the hang budget
  | 'crash'; // the tool process died or printed something unparseable

export type Claim = {
  status: ClaimStatus;
  ms: number;
  /** The tool's own words (trimmed). */
  output: string;
  /** The exact command or call, for reproduction. */
  call: string;
  exitCode?: number | undefined;
};

/** One on-screen element as the tool presents it to an agent. */
export type Element = {
  ref: string;
  role: string;
  label: string;
  value?: string | undefined;
  rect?: { x: number; y: number; w: number; h: number } | undefined;
  /** The tool itself says a tap cannot reach this element (keyboard, covered, not hittable). */
  blocked?: string | undefined;
};

export type Observation = {
  claim: Claim;
  elements: Element[];
  /** Frontmost app as the tool names it. */
  app?: string | undefined;
  raw: string;
};

/** A device tool driven through its own documented interface, the way an agent would. */
export interface Adapter {
  readonly name: string;
  /** Tool version / revision, pinned in every result. */
  version(): Promise<string>;
  observe(): Promise<Observation>;
  /** Read all visible text the documented way (an agent checking what a screen says). */
  readScreen(): Promise<{ claim: Claim; text: string }>;
  /** Untimed, unscored: what an agent does when it starts on a freshly launched app (agent-device: open). */
  afterAppLaunch?(): Promise<void>;
  tapRef(el: Element): Promise<Claim>;
  tapLabel(label: string): Promise<Claim>;
  /** Tap a control that may be below the fold, the tool's documented way (scroll to it, then tap). */
  scrollToAndTap(label: string): Promise<Claim>;
  tapPoint(x: number, y: number): Promise<Claim>;
  /** Replace a field's content, finding the field by its label or placeholder. */
  fill(fieldLabel: string, text: string): Promise<Claim>;
  dismissKeyboard(): Promise<Claim>;
  /** Set a switch found by its row label to the desired state. */
  setSwitch(label: string, on: boolean): Promise<Claim>;
  alert(action: 'accept' | 'dismiss'): Promise<Claim>;
  /** Tier 2: the tool's own documented command to uninstall an app from its device. */
  uninstallApp?(bundleId: string): Promise<Claim>;
  /** Release long-lived resources (an MCP server process). */
  close?(): Promise<void>;
  /** Tier 2: end this device's session abruptly, as a crash or timeout would. Returns what it did. */
  killSession?(): Promise<string>;
}

/** One line of Gauntlet's Documents/events.jsonl. */
export type Ev = {
  kind: string;
  run: string;
  scenario: string;
  seed: number;
  t: number;
  [k: string]: unknown;
};

/** What actually happened, judged from the oracle (never from the tool's reply). */
export type Effect =
  | 'intended' // the thing the agent asked for happened, and nothing else
  | 'wrong' // something else happened (other control, side effect, left the app)
  | 'partial' // the right target, but a corrupted or incomplete result
  | 'none'; // nothing happened

/** What a correct tool does on this probe. */
export type Expect = 'act' | 'refuse' | 'either';

export type Verdict =
  | 'pass'
  | 'false_success' // claimed ok, ground truth says no (the headline failure)
  | 'flagged_failure' // failed, but the tool hedged ("did NOT change")
  | 'refused_wrongly' // honest error on something it should have done
  | 'unsafe_error' // reported an error, yet something (wrong) happened
  | 'false_failure' // did the right thing but reported an error
  | 'leak' // did the right thing but echoed a secret into its output
  | 'unsupported'
  | 'hang'
  | 'crash'
  | 'invalid' // the scenario's precondition did not hold; not scored
  | 'setup_failed'; // an easy setup step failed through the tool; scored as a failure

export type ProbeOutcome = {
  /** The claim for the step under test. */
  claim?: Claim | undefined;
  effect?: Effect | undefined;
  detail: string;
  invalid?: string | undefined;
  setupFailed?: string | undefined;
  /** The probe as a whole ran out of time: the tool's hang, not a fixture fault. */
  hung?: string | undefined;
  /** Extra measurements (latencies, touch offsets, what was offered). */
  extra?: Record<string, unknown> | undefined;
  /** Every tool call the probe made, in order. */
  calls?: Claim[] | undefined;
};

export type ProbeResult = ProbeOutcome & {
  probe: string;
  title: string;
  tool: string;
  toolVersion: string;
  split: 'dev' | 'heldout';
  seed: number;
  run: string;
  expect: Expect;
  verdict: Verdict;
  ms: number;
  events: Ev[];
};
