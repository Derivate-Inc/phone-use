import { cp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end smoke test of the shared atlas — the "exploration compounds across
// agents" property. Points the atlas at a throwaway dir, exports the learned
// Settings map, wipes it (a "fresh phone"), inspects (should read NEW), imports,
// then navigates LIVE via the inherited map and asserts it was cached — i.e. the
// fresh phone reached the screen with zero crawl of its own.
//   bun scripts/smoke-atlas.ts   (needs a booted simulator; the phone-use runner starts on first use)

const SETTINGS = 'com.apple.Preferences';
const TMP = join(tmpdir(), 'pu-smoke-atlas');
process.env.PHONE_USE_MAP_DIR = join(TMP, 'maps'); // must be set BEFORE importing appmap

const { smartGoto } = await import('../src/explore.ts');
const { loadMap, saveMap, listMaps, forgetMap } = await import('../src/appmap.ts');
const { exportAtlas, inspectAtlas, importAtlas } = await import('../src/atlas.ts');
const driver = await import('../src/driver.ts');
const io = { loadMap, saveMap };

let ok = false;
try {
  await mkdir(join(TMP, 'maps'), { recursive: true });
  // Seed from the real learned map for speed; build one if there's none yet.
  await cp(
    join(homedir(), '.phone-use', 'maps', `${SETTINGS}.json`),
    join(TMP, 'maps', `${SETTINGS}.json`),
  ).catch(() => {});
  if (!(await listMaps()).includes(SETTINGS)) await smartGoto(SETTINGS, 'About', io);

  const bundle = await exportAtlas([SETTINGS]);
  await forgetMap(SETTINGS); // wipe → a fresh phone
  const emptied = (await listMaps()).length === 0;

  const diff = await inspectAtlas(bundle);
  const readsNew = diff.apps.find((a) => a.app === SETTINGS)?.status === 'new';

  await importAtlas(bundle); // inherit

  const r = await smartGoto(SETTINGS, 'About', io); // navigate live via inherited map
  await driver.observe();
  const landed = /iOS Version/i.test(driver.currentElements().elements);

  ok = emptied && readsNew && r.ok && r.mapped === 'cached' && landed;
  console.log(
    `emptied=${emptied} inspect=new:${readsNew} nav.ok=${r.ok} mapped=${r.mapped} landed=${landed}`,
  );
  console.log(ok ? 'PASS — inherited atlas navigates with zero crawl' : 'FAIL');
} catch (error) {
  console.log(`FAIL — ${String(error).slice(0, 200)}`);
} finally {
  await rm(TMP, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
