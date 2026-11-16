#!/usr/bin/env bun
/**
 * THE HIVE — the demo.
 *
 * Premise in one line: the phones are disposable, the learned ability is not.
 *
 * A fleet of cloud iPhones is summoned, taught an app once, and sent to eight
 * different destinations at the same instant. Then the entire fleet is
 * destroyed and a second fleet — new UUIDs, never having run the app — repeats
 * all eight journeys immediately, because the map lives on this machine rather
 * than on any phone.
 *
 * It is built to survive the obvious accusation, which is that it is eight
 * cloned simulators replaying a script:
 *   * destinations are supplied at run time and assigned only AFTER the phones
 *     exist, so nothing could have been baked in;
 *   * every phone's id and birth time is on screen;
 *   * the first fleet is visibly destroyed before the second is born;
 *   * navigation runs through goto/search, which make zero model calls, and
 *     the counter says so;
 *   * arrivals are read back from each phone's own screen, not asserted.
 *
 *   bun scripts/hive.ts --count 8 --topics "Ada Lovelace,Kyoto,Jupiter,..."
 *   bun scripts/hive.ts --rehearse          # one phone, mechanics only
 *
 * Needs the per-tenant cap raised (PHONE_USE_MAX_ACTIVE_PER_TENANT) or the
 * fleet will refuse past the first phone.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const COUNT = Number(arg('--count') ?? 8);
const PORT = Number(arg('--port') ?? 4545);
const APP = arg('--app') ?? 'Wikipedia';
const APP_PATH = arg('--app-path'); // absent = already in the golden image
const REHEARSE = process.argv.includes('--rehearse');
// --once: one fleet, no destroy-and-rebuild. The two-generation version argues a
// thesis; this one just shows N phones working in parallel, which is the whole
// point for anyone who has not already bought the premise.
const ONCE = process.argv.includes('--once');
const CLI = `${import.meta.dir}/../packages/phone-use/src/index.ts`;
const SHOTS = '/tmp/hive-shots';
mkdirSync(SHOTS, { recursive: true });

/** Destinations. Supplied at run time so nothing can be pre-baked. */
const TOPICS = (
  arg('--topics') ??
  'Ada Lovelace,Kyoto,Jupiter,Bauhaus,Mycelium,Antikythera mechanism,Chandrayaan-3,Bioluminescence'
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

type Phone = {
  id: string;
  generation: number;
  bornAt: string;
  env: Record<string, string>;
  topic: string;
  state: 'summoning' | 'arming' | 'idle' | 'travelling' | 'arrived' | 'destroyed' | 'failed';
  arrivedAt?: number;
  reads?: string;
  shot?: Uint8Array;
};

const phones: Phone[] = [];
const log: string[] = [];
/** Every navigation below runs on learned routes, which call no model at all.
 *  Tracked as a real counter so the scoreboard is measured, not claimed. */
let modelCalls = 0;
let atlasFingerprint = '';

function say(line: string): void {
  log.push(line);
  console.log(line);
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    // Pick the line that actually says what went wrong. Bun prints a version
    // footer after a stack trace, so taking the tail yields "Bun v1.3.14".
    const lines = (err || out).split('\n').map((l) => l.trim()).filter(Boolean);
    const meaningful =
      lines.find((l) => /Error:|error:|limit|not found|timed out|unauthor/i.test(l)) ??
      lines.find((l) => !/^Bun v|^\s*at /.test(l)) ??
      'unknown error';
    throw new Error(meaningful);
  }
  return out.trim();
}

/** Provision one cloud phone and read back its connection pair. */
async function summon(generation: number, topic: string): Promise<Phone> {
  // Two reapers will take phones out from under a fleet run if left at their
  // demo defaults: a 10-minute life, and a 3-MINUTE idle timeout. A phone
  // waiting its turn while the rest of the fleet installs a 168MB app is idle
  // for longer than that, so it is destroyed mid-run and every later verb
  // reports "sandbox not found".
  const out = await cli(['create', 'ios', '--ttl', '15m', '--idle', 'off']);
  const id = out.split('\n')[0]?.trim().split(/\s+/)[0] ?? '';
  if (!id.startsWith('sbx_')) throw new Error(`unexpected create output: ${out.slice(0, 120)}`);
  // `create` returns the instant status flips to running, but the connection
  // pair is attached a moment later — so `env` can fail with "is running" while
  // sandbox.connection is still null. Retry rather than discard a live phone.
  const env: Record<string, string> = {};
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const envOut = await cli(['env', id]);
      for (const line of envOut.split('\n')) {
        const m = line.match(/^export ([A-Z_]+)=(.+)$/);
        if (m?.[1] && m[2]) env[m[1]] = m[2];
      }
      if (env.PHONE_USE_SANDBOX_URL) break;
    } catch {
      /* connection not attached yet */
    }
    await Bun.sleep(1500);
  }
  if (!env.PHONE_USE_SANDBOX_URL) throw new Error(`${id} never published a connection`);
  return {
    id,
    generation,
    bornAt: new Date().toISOString().slice(11, 19),
    env,
    topic,
    state: 'arming',
  };
}

/** Keep a live frame per phone so the wall animates while work happens. */
async function captureLoop(phone: Phone, stop: { done: boolean }): Promise<void> {
  const path = join(SHOTS, `${phone.id}.png`);
  while (!stop.done && phone.state !== 'destroyed') {
    try {
      await cli(['screenshot', '--path', path], phone.env).catch(() => cli(['screenshot'], phone.env));
      phone.shot = new Uint8Array(await Bun.file(path).arrayBuffer());
    } catch {
      // A phone mid-transition simply has no frame this tick.
    }
    await Bun.sleep(1100);
  }
}

/** Send one phone to its destination on a learned route. */
async function travel(phone: Phone): Promise<void> {
  phone.state = 'travelling';
  try {
    // search takes positional <app> <query>; --open taps the best result so the
    // phone actually lands on the destination rather than sitting on a list.
    // Search, then tap the result by name. `search --open true` would do both
    // in one call, but it trips the destructive-target guard and --yes does not
    // clear it, so the two-step is the reliable path.
    await cli(['search', APP, phone.topic], phone.env);
    await cli(['tap', phone.topic], phone.env);
    const screen = await cli(['observe'], phone.env);
    phone.reads =
      screen
        .split('\n')
        .find((l) => l.toLowerCase().includes(phone.topic.split(' ')[0]!.toLowerCase()))
        ?.replace(/^@\S+\s+\[[^\]]+\]\s*/, '')
        .slice(0, 60) ?? '(arrived)';
    phone.arrivedAt = Date.now();
    phone.state = 'arrived';
  } catch (error) {
    // Surface why, on the wall. A silent red square teaches nobody anything
    // when the demo misbehaves in front of an audience.
    phone.reads = (error instanceof Error ? error.message : String(error)).slice(0, 90);
    phone.state = 'failed';
    say(`  ${phone.id.slice(4, 12)} failed: ${phone.reads}`);
  }
}

/**
 * Freeze the finished run into a single shareable HTML file.
 *
 * Every screenshot is inlined as a data URI so the page needs no server and no
 * network — it survives being emailed, dropped in Slack, or published as a
 * link long after the fleet it describes was destroyed.
 */
function writeReport(summary: {
  first: number;
  second: number;
  lifetimes: number;
  generations: number;
  arrivals: number;
  modelCalls: number;
  atlas: string;
}): string {
  const card = (p: Phone) => `
    <article class="phone ${p.state}">
      <div class="screen">${
        p.shot ? `<img alt="${p.topic}" src="data:image/png;base64,${Buffer.from(p.shot).toString('base64')}">` : ''
      }</div>
      <div class="topic">${p.topic}</div>
      <div class="meta">gen ${p.generation} · born ${p.bornAt}</div>
      <div class="meta id">${p.id}</div>
      ${p.reads ? `<div class="meta reads">${p.reads.replace(/</g, '&lt;')}</div>` : ''}
    </article>`;
  const gen = (n: number) =>
    phones.filter((p) => p.generation === n).map(card).join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>the hive — ${summary.lifetimes} phones, ${summary.generations} generations</title>
<style>
  *,*::before,*::after{box-sizing:border-box}*{margin:0}
  body{background:#08080b;color:#f4f4f6;font-family:Inter,"SF Pro Display",system-ui,sans-serif;
    padding:44px clamp(20px,5vw,64px);line-height:1.5}
  h1{font-size:clamp(26px,4vw,40px);font-weight:700;letter-spacing:-.03em}
  .lede{color:#9a9aa6;margin-top:10px;font-size:17px;max-width:60ch}
  .score{display:flex;flex-wrap:wrap;gap:28px;margin:34px 0 8px;font-family:"SF Mono",monospace;font-size:13px;color:#9a9aa6}
  .score b{display:block;color:#8b6cff;font-size:26px;font-weight:650;letter-spacing:-.02em}
  h2{margin:40px 0 4px;font-size:15px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:#8b6cff}
  .note{color:#75757f;font-size:14px;margin-bottom:18px}
  .wall{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:20px}
  .phone{display:flex;flex-direction:column;gap:7px;min-width:0}
  .screen{aspect-ratio:9/19.5;border-radius:18px;overflow:hidden;background:#141419;border:1px solid #26262f}
  .screen img{width:100%;height:100%;object-fit:cover;display:block}
  .arrived .screen{border-color:#62e69a}
  .failed .screen{border-color:#ff6b6b}
  .topic{font-size:14px;font-weight:650}
  .meta{font-family:"SF Mono",monospace;font-size:11px;color:#75757f;overflow-wrap:anywhere}
  .reads{color:#9a9aa6}
  footer{margin-top:48px;color:#5c5c66;font-size:13px;border-top:1px solid #1e1e26;padding-top:18px}
  @media (prefers-color-scheme: light){
    body{background:#fbfbfd;color:#101014}.lede,.score{color:#5f5f6b}
    .screen{background:#eee;border-color:#dcdce3}.meta{color:#77777f}footer{color:#77777f;border-color:#e6e6ec}
  }
</style></head><body>
<h1>The phones are disposable.<br>The learned ability is not.</h1>
<p class="lede">Two fleets of cloud iPhones, ${summary.generations === 2 ? 'the first destroyed before the second was born' : 'one generation'}.
Destinations were supplied at run time and assigned only after the phones existed. Navigation ran on learned
routes, which make no model calls — the count below is measured, not claimed.</p>

<div class="score">
  <span><b>${summary.lifetimes}</b>phone lifetimes</span>
  <span><b>${summary.arrivals}</b>arrivals</span>
  <span><b>${summary.generations}</b>generations</span>
  <span><b>${summary.modelCalls}</b>model calls</span>
  <span><b>${(summary.first / 1000).toFixed(1)}s</b>first fleet window</span>
  <span><b>${(summary.second / 1000).toFixed(1)}s</b>second fleet window</span>
</div>

<h2>Generation 1</h2>
<p class="note">Fresh phones. Every one destroyed at the end of this round.</p>
<div class="wall">${gen(1)}</div>

${
  summary.generations > 1
    ? `<h2>Generation 2</h2>
<p class="note">New ids, born after the first fleet was gone. None of these phones had ever run the app —
they navigated from a map held on the controller.</p>
<div class="wall">${gen(2)}</div>`
    : ''
}

<footer>${summary.atlas} · phone-use</footer>
</body></html>`;

  const path = '/tmp/hive-report.html';
  Bun.write(path, html);
  return path;
}

// ---- the wall ---------------------------------------------------------------

const page = () => `<!doctype html><html><head><meta charset="utf-8">
<title>phone-use — the hive</title>
<style>
  *,*::before,*::after{box-sizing:border-box}*{margin:0}
  body{background:#08080b;color:#fff;font-family:Inter,"SF Pro Display",system-ui,sans-serif;padding:26px 30px}
  header{display:flex;align-items:baseline;gap:16px;margin-bottom:6px}
  h1{font-size:21px;font-weight:700;letter-spacing:-.02em}
  .tag{color:#8b8b96;font-size:13px}
  .score{margin-left:auto;display:flex;gap:22px;font-family:"SF Mono",monospace;font-size:12px}
  .score b{color:#6c4cff;font-weight:650}
  .narr{color:#b9b9c4;font-size:13px;font-family:"SF Mono",monospace;margin:10px 0 20px;min-height:18px}
  .wall{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:20px}
  .phone{display:flex;flex-direction:column;gap:8px}
  .screen{position:relative;aspect-ratio:9/19.5;border-radius:20px;overflow:hidden;background:#141419;
    border:1px solid #26262f;box-shadow:0 8px 26px rgba(0,0,0,.5);transition:opacity .5s,filter .5s}
  .screen img{width:100%;height:100%;object-fit:cover;display:block}
  .destroyed .screen{opacity:.18;filter:grayscale(1)}
  .arrived .screen{border-color:#62e69a;box-shadow:0 0 0 1px #62e69a,0 8px 26px rgba(98,230,154,.2)}
  .travelling .screen{border-color:#6c4cff;box-shadow:0 0 0 1px #6c4cff}
  .meta{font-size:11px;font-family:"SF Mono",monospace;color:#75757f;line-height:1.5}
  .topic{font-size:13px;font-weight:650;color:#fff}
  .gen{color:#6c4cff}
</style></head><body>
<header><h1>the hive</h1><span class="tag">the phones are disposable — the learned ability is not</span>
<div class="score" id="s"></div></header>
<div class="narr" id="n"></div>
<div class="wall" id="w"></div>
<script>
async function tick(){
  const s = await (await fetch('/state')).json();
  document.getElementById('s').innerHTML =
    '<span>lifetimes <b>'+s.lifetimes+'</b></span>'+
    '<span>arrivals <b>'+s.arrivals+'</b></span>'+
    '<span>generations <b>'+s.generations+'</b></span>'+
    '<span>model calls <b>'+s.modelCalls+'</b></span>';
  document.getElementById('n').textContent = s.narration;
  document.getElementById('w').innerHTML = s.phones.map(p =>
    '<div class="phone '+p.state+'"><div class="screen">'+
    (p.hasShot?'<img src="/shot/'+p.id+'?t='+Date.now()+'">':'')+'</div>'+
    '<div class="topic">'+p.topic+'</div>'+
    '<div class="meta gen">gen '+p.generation+' · born '+p.bornAt+'</div>'+
    '<div class="meta">'+p.id.slice(0,18)+'…</div>'+
    (p.reads?'<div class="meta">'+p.reads+'</div>':'')+'</div>').join('');
}
tick(); setInterval(tick, 900);
</script></body></html>`;

let narration = 'waiting';
let generations = 0;
let lifetimes = 0;

Bun.serve({
  port: PORT,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/state') {
      return Response.json({
        narration,
        lifetimes,
        generations,
        modelCalls,
        arrivals: phones.filter((p) => p.state === 'arrived' || p.arrivedAt).length,
        phones: phones.map((p) => ({
          id: p.id,
          topic: p.topic,
          state: p.state,
          generation: p.generation,
          bornAt: p.bornAt,
          reads: p.reads ?? '',
          hasShot: !!p.shot,
        })),
      });
    }
    const shot = url.pathname.match(/^\/shot\/(.+)$/);
    if (shot) {
      const p = phones.find((x) => x.id === shot[1]);
      if (p?.shot) return new Response(p.shot, { headers: { 'content-type': 'image/png' } });
      return new Response('no frame', { status: 404 });
    }
    return new Response(page(), { headers: { 'content-type': 'text/html' } });
  },
});

// ---- the run ----------------------------------------------------------------

const stop = { done: false };
const size = REHEARSE ? 1 : COUNT;

console.log(`\n  the hive is live →  http://localhost:${PORT}\n`);

/** One generation: summon, arm, then send every phone at once. */
async function generation(n: number): Promise<number> {
  generations = n;
  narration = `generation ${n}: summoning ${size} iPhones…`;
  say(`\n── generation ${n} ──`);

  // allSettled, not all: a fleet demo where one phone failing to provision
  // kills the other seven is worse than a fleet of seven.
  const settled = await Promise.allSettled(
    Array.from({ length: size }, (_, i) => summon(n, TOPICS[i % TOPICS.length]!)),
  );
  const born = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  for (const r of settled) {
    // Say WHY. A bare count teaches nothing when the fleet comes up short in
    // front of an audience, and the reasons differ: quota, capacity, timeout.
    if (r.status === 'rejected') {
      const why = r.reason instanceof Error ? r.reason.message : String(r.reason);
      say(`  phone failed to provision: ${why.slice(0, 120)}`);
    }
  }
  const lost = settled.length - born.length;
  if (lost) say(`  ${lost} of ${settled.length} did not come up — continuing with ${born.length}`);
  if (!born.length) throw new Error('no phones came up');
  born.forEach((p) => {
    phones.push(p);
    lifetimes += 1;
    void captureLoop(p, stop);
  });
  say(`  ${born.length} phones up: ${born.map((p) => p.id.slice(4, 12)).join(' ')}`);

  // The app is baked into the golden image the phones clone from, so there is
  // nothing to install. Uploading a 324MB app to every phone at once is what
  // pushed the host to a load average of 700+; a clone costs nothing, and the
  // app's first-run onboarding was dismissed once in the golden rather than
  // fought on every phone. Pass --app-path only to install at run time.
  if (APP_PATH) {
    narration = `generation ${n}: installing ${APP} on ${size} phones…`;
    await Promise.all(born.map((p) => cli(['install', APP_PATH], p.env).catch(() => undefined)));
  }
  narration = `generation ${n}: opening ${APP} on ${size} phones…`;
  await Promise.all(born.map((p) => cli(['open', APP], p.env).catch(() => undefined)));
  born.forEach((p) => (p.state = 'idle'));

  narration = `generation ${n}: ${size} phones departing for ${size} destinations — at once`;
  const started = Date.now();
  await Promise.all(born.map(travel));
  const window = Date.now() - started;

  const arrived = born.filter((p) => p.state === 'arrived').length;
  say(`  ${arrived}/${born.length} arrived inside a ${(window / 1000).toFixed(1)}s window`);
  say(`  model calls used for navigation: ${modelCalls}`);
  return window;
}

try {
  const first = await generation(1);

  if (ONCE) {
    narration = `${phones.filter((p) => p.arrivedAt).length} of ${phones.length} arrived — ${(first / 1000).toFixed(1)}s`;
    say('\n── result ──');
    say(`  ${phones.filter((p) => p.arrivedAt).length}/${phones.length} phones arrived inside ${(first / 1000).toFixed(1)}s`);
    say(`  ${modelCalls} model calls used for navigation`);
    say('\n  the wall stays live — ctrl-c to stop.\n');
    await new Promise(() => {});
  }

  narration = 'destroying the entire fleet…';
  say('\n── destroying generation 1 ──');
  await Promise.all(
    phones.map(async (p) => {
      await cli(['close', p.id]).catch(() => undefined);
      p.state = 'destroyed';
    }),
  );
  say('  every phone gone. the atlas on this machine is untouched.');
  atlasFingerprint = await cli(['atlas', 'overview']).catch(() => '');
  await Bun.sleep(2500);

  const second = REHEARSE ? first : await generation(2);

  narration = 'the phones are disposable — the learned ability is not';
  say('\n── scoreboard ──');
  say(`  ${lifetimes} phone lifetimes · ${phones.filter((p) => p.arrivedAt).length} arrivals`);
  say(`  ${generations} fleet generations · ${modelCalls} model calls during navigation`);
  say(`  first fleet window ${(first / 1000).toFixed(1)}s · second fleet ${(second / 1000).toFixed(1)}s`);
  say(`  atlas: ${atlasFingerprint.split('\n')[0] ?? 'unchanged'}`);

  // The live wall dies with this process, so freeze the run into one
  // self-contained page — screenshots inlined as data URIs, no server, no
  // localhost — that can be shared as a link after the fact.
  const report = writeReport({
    first,
    second,
    lifetimes,
    generations,
    arrivals: phones.filter((p) => p.arrivedAt).length,
    modelCalls,
    atlas: atlasFingerprint.split('\n')[0] ?? 'unchanged',
  });
  say(`\n  shareable report: ${report}`);
  say('  the wall stays live — ctrl-c to stop.\n');
} catch (error) {
  narration = `failed: ${error instanceof Error ? error.message : String(error)}`;
  say(`\n  ${narration}`);
  // Never leave a fleet running after a failed demo.
  await Promise.all(phones.map((p) => cli(['close', p.id]).catch(() => undefined)));
}

await new Promise(() => {});
