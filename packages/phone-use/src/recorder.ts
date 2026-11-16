import { currentExecution } from './execution-context.ts';
import type { Skill, SkillStep } from './skills.ts';
import { saveSkill } from './skills.ts';

// Learn a skill by watching. While a recording is active, each successful intent
// primitive (open_app/goto/ask/toggle/search/search_open) appends itself as a
// step. Stop → the captured chain is saved as a replayable skill. So an agent
// performs an errand once, and the phone can repeat it forever with zero model
// calls — the authoring counterpart to hand-writing skill steps.

let defaultSession: { name: string; description?: string | undefined; steps: SkillStep[] } | null = null;

function getSession() {
  return currentExecution()?.recording ?? (currentExecution() ? null : defaultSession);
}
function setSession(value: typeof defaultSession) {
  const scoped = currentExecution();
  if (scoped) scoped.recording = value;
  else defaultSession = value;
}

export function startRecording(name: string, description?: string): void {
  setSession({ name, description, steps: [] });
}

// Called from the MCP tool handlers after a primitive succeeds. A no-op unless a
// recording is active, so it's safe to call unconditionally.
export function record(step: SkillStep): void {
  getSession()?.steps.push(step);
}

export function recordingStatus(): { name: string; steps: number } | null {
  const session = getSession();
  return session ? { name: session.name, steps: session.steps.length } : null;
}

// End the recording and persist it (only if it captured at least one step).
export async function stopRecording(): Promise<Skill | null> {
  const session = getSession();
  if (!session) return null;
  const skill: Skill = { name: session.name, description: session.description, steps: session.steps };
  setSession(null);
  if (skill.steps.length) await saveSkill(skill);
  return skill;
}
