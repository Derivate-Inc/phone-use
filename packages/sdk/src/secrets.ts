// ---------------------------------------------------------------------------
// %variable% secret substitution (Stagehand's pattern):
// the model/caller plans against NAMES; values are injected at the last moment
// before backend.fill/typeText and never rendered into Actions, results,
// observations, or traces. Redaction is best-effort belt-and-braces — after
// typing into a non-secure field the next snapshot's value contains the
// secret, and redact() at observe/result assembly keeps it out of outbound
// text. The hard guarantee is at the substitution point: values never enter
// stored Actions by construction.
// ---------------------------------------------------------------------------

const MIN_SECRET_LENGTH = 4;

/**
 * `%variable%` secret substitution (Stagehand's pattern):
 * the model/caller plans against NAMES; values are injected at the last moment
 * before backend.fill/typeText and never rendered into Actions, results,
 * observations, or traces. Redaction is best-effort belt-and-braces; the hard
 * guarantee is at the substitution point — values never enter stored Actions
 * by construction.
 */
export class SecretStore {
  private readonly values = new Map<string, string>();

  constructor(values?: Record<string, string>) {
    if (values) for (const [k, v] of Object.entries(values)) this.set(k, v);
  }

  /**
   * Store a secret under `name`. Rejects values shorter than 4 chars — a
   * 2-char secret would redact innocent UI text everywhere.
   */
  set(name: string, value: string): void {
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(`secret "${name}" is too short (<${MIN_SECRET_LENGTH} chars) to redact safely`);
    }
    this.values.set(name, value);
  }

  /** The stored secret NAMES (never the values). */
  names(): string[] {
    return [...this.values.keys()];
  }

  /** %name% → value. Unknown %x% stays literal. */
  substitute(text: string): string {
    return text.replace(/%([A-Za-z0-9_-]+)%/g, (whole, name: string) => this.values.get(name) ?? whole);
  }

  /** value → %name% across outbound text (messages, rendered observations). */
  redact(text: string): string {
    let out = text;
    for (const [name, value] of this.values) {
      out = out.split(value).join(`%${name}%`);
    }
    return out;
  }

  /** Per-call vars layered over the store (call-scoped, never persisted). */
  withOverrides(vars?: Record<string, string>): SecretStore {
    if (!vars || Object.keys(vars).length === 0) return this;
    const merged = new SecretStore();
    for (const [k, v] of this.values) merged.values.set(k, v);
    for (const [k, v] of Object.entries(vars)) merged.set(k, v);
    return merged;
  }
}
