import * as driver from '../src/driver.ts';
import { forgetSkill, loadSkill, parameterizeSkill, runSkill, type Skill, saveSkill } from '../src/skills.ts';

// Smoke test of the full skill lifecycle — record → generalize → replay → prune.
// The key property: one recording generalizes to many. A skill recorded to
// navigate "About" is parameterized to {{screen}} and then replayed for a
// DIFFERENT screen (Accessibility), proving substitution + the missing-arg
// guard, then forgotten. (Needs a booted simulator; the phone-use runner starts on first use.)
//   bun scripts/smoke-skill.ts

const NAME = 'smoke-skill';

let ok = false;
try {
  // A recorded literal: navigate to About.
  const literal: Skill = {
    name: NAME,
    steps: [{ op: 'goto', app: 'com.apple.Preferences', destination: 'About' }],
  };
  await saveSkill(literal);

  // Generalize: promote the literal "About" to a {{screen}} slot.
  const generic = parameterizeSkill(literal, { screen: 'About' });
  await saveSkill(generic);
  const loaded = await loadSkill(NAME);
  const step0 = loaded?.steps[0] as { destination?: string } | undefined;
  const parameterized = !!loaded?.params?.includes('screen') && step0?.destination === '{{screen}}';

  // Replay the SAME recording for a DIFFERENT screen.
  await driver.openApp('com.apple.Preferences', true);
  await Bun.sleep(600);
  const run = await runSkill(generic, { screen: 'Accessibility' });
  await driver.observe();
  const landed = /Vision/i.test(driver.currentElements().elements); // Accessibility landing section

  // The missing-arg guard must fail fast rather than navigate to "".
  const guarded = !(await runSkill(generic, {})).ok;

  // Prune.
  const forgot = await forgetSkill(NAME);
  const gone = (await loadSkill(NAME)) === null;

  ok = parameterized && run.ok && landed && guarded && forgot && gone;
  console.log(
    `parameterized=${parameterized} run.ok=${run.ok} landed=${landed} guard=${guarded} forgot=${forgot} gone=${gone}`,
  );
  console.log(ok ? 'PASS — record → parameterize → replay (generalized) → forget' : 'FAIL');
} catch (error) {
  console.log(`FAIL — ${String(error).slice(0, 200)}`);
} finally {
  await forgetSkill(NAME).catch(() => {});
}

process.exit(ok ? 0 : 1);
