#!/usr/bin/env bun
/**
 * The video wall: many iPhones, one command, all working at once.
 *
 * A phone is the least fungible object in computing — one person, one hand, one
 * device. So the thing worth showing is not a phone being driven; it is a dozen
 * of them appearing on demand and moving in unison, which is exactly the cell
 * no iOS supplier fills today.
 *
 *   bun scripts/swarm.ts              # every available iPhone
 *   bun scripts/swarm.ts --count 4    # cap the fleet
 *   bun scripts/swarm.ts --port 4000
 *
 * Opens a live wall at http://localhost:<port>. Screens refresh continuously
 * while each phone runs its own errand, so the whole fleet is visible moving
 * together rather than one screenshot at a time.
 */
import { $ } from 'bun';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PORT = Number(arg('--port') ?? 3939);
const LIMIT = Number(arg('--count') ?? 12);
const CLI = `${import.meta.dir}/../packages/phone-use/src/index.ts`;

/** One errand per phone. Different apps and verbs so the wall reads as a fleet
 *  doing real work, not one script copy-pasted. */
type Errand = { app: string; label: string; run: (udid: string) => Promise<void> };

const cli = (udid: string, args: string[]) =>
  Bun.spawn(['bun', CLI, ...args], {
    env: { ...process.env, PHONE_USE_DEVICE: udid },
    stdout: 'pipe',
    stderr: 'pipe',
  }).exited;

const ERRANDS: Errand[] = [
  {
    app: 'Wikipedia',
    label: 'read about Ada Lovelace',
    run: async (u) => {
      await cli(u, ['open', 'Wikipedia']);
      await cli(u, ['search', '--app', 'Wikipedia', '--query', 'Ada Lovelace']);
      await cli(u, ['tap', 'Ada Lovelace', '--role', 'Cell']);
    },
  },
  {
    app: 'Ice Cubes',
    label: 'browse a Mastodon timeline',
    run: async (u) => {
      await cli(u, ['open', 'Ice Cubes']);
      await cli(u, ['handle_alert', '--action', 'accept']);
      await cli(u, ['scroll', '--direction', 'down']);
    },
  },
  {
    app: 'Cinephile',
    label: 'check a wishlist bug',
    run: async (u) => {
      await cli(u, ['open', 'Cinephile']);
      await cli(u, ['tap', 'The Odyssey', '--role', 'Button']);
      await cli(u, ['tap', 'Wishlist', '--role', 'Button']);
      await cli(u, ['tap', 'My Lists']);
    },
  },
  {
    app: 'Settings',
    label: 'read the iOS version',
    run: async (u) => {
      await cli(u, ['open', 'Settings']);
      await cli(u, ['ask', 'Software Version', '--app', 'Settings']);
    },
  },
];

type Phone = {
  udid: string;
  name: string;
  errand: Errand;
  state: 'booting' | 'installing' | 'working' | 'done' | 'failed';
  shot: Uint8Array | null;
};

const phones: Phone[] = [];

/** Latest frame per phone, captured continuously so the wall animates. */
async function captureLoop(phone: Phone, stop: { done: boolean }): Promise<void> {
  const path = `/tmp/swarm-${phone.udid}.png`;
  while (!stop.done) {
    try {
      await $`xcrun simctl io ${phone.udid} screenshot --type=png ${path}`.quiet();
      phone.shot = new Uint8Array(await Bun.file(path).arrayBuffer());
    } catch {
      // A phone mid-transition simply has no frame this tick.
    }
    await Bun.sleep(900);
  }
}

const page = () => `<!doctype html><html><head><meta charset="utf-8">
<title>phone-use — the wall</title>
<style>
  :root{--ink:#101014;--muted:#666670;--violet:#6c4cff;--line:#e5e5eb}
  *,*::before,*::after{box-sizing:border-box}*{margin:0}
  body{background:#0d0d10;color:#fff;font-family:Inter,"SF Pro Display",system-ui,sans-serif;padding:28px 32px}
  header{display:flex;align-items:baseline;gap:14px;margin-bottom:22px}
  h1{font-size:22px;font-weight:700;letter-spacing:-.02em}
  .sub{color:#8b8b96;font-size:14px}
  .count{margin-left:auto;font-family:"SF Mono",monospace;color:var(--violet);font-size:14px;font-weight:650}
  .wall{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:22px}
  .phone{display:flex;flex-direction:column;gap:9px}
  .screen{position:relative;aspect-ratio:9/19.5;border-radius:22px;overflow:hidden;
    background:#17171c;border:1px solid #2a2a33;box-shadow:0 10px 30px rgba(0,0,0,.45)}
  .screen img{width:100%;height:100%;object-fit:cover;display:block}
  .meta{display:flex;align-items:center;gap:7px;font-size:12px}
  .dot{width:7px;height:7px;border-radius:50%;background:#4a4a55;flex:0 0 auto}
  .working .dot{background:var(--violet);animation:pulse 1.1s ease-in-out infinite}
  .done .dot{background:#62e69a}.failed .dot{background:#ff6b6b}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .name{font-weight:650}.task{color:#8b8b96}
</style></head><body>
<header>
  <h1>phone-use</h1><span class="sub">every phone is real, and every one is working right now</span>
  <span class="count" id="c"></span>
</header>
<div class="wall" id="w"></div>
<script>
async function tick(){
  const r = await fetch('/state'); const s = await r.json();
  document.getElementById('c').textContent = s.phones.length + ' iPhONES';
  document.getElementById('w').innerHTML = s.phones.map(p =>
    '<div class="phone ' + p.state + '"><div class="screen">' +
    (p.hasShot ? '<img src="/shot/' + p.udid + '?t=' + Date.now() + '">' : '') +
    '</div><div class="meta"><span class="dot"></span><span class="name">' + p.name +
    '</span></div><div class="meta"><span class="task">' + p.task + '</span></div></div>').join('');
}
tick(); setInterval(tick, 1000);
</script></body></html>`;

// ---- boot the fleet -------------------------------------------------------

const list = await $`xcrun simctl list devices available --json`.json();
const candidates: Array<{ udid: string; name: string; booted: boolean }> = [];
for (const runtime of Object.keys(list.devices)) {
  for (const d of list.devices[runtime]) {
    if (/iPhone/.test(d.name)) {
      candidates.push({ udid: d.udid, name: d.name, booted: d.state === 'Booted' });
    }
  }
}
// Already-booted phones first: a warm pool is how the product actually works,
// and it is what makes the wall fill instantly instead of after a boot wait.
candidates.sort((a, b) => Number(b.booted) - Number(a.booted));
const fleet = candidates.slice(0, LIMIT);
if (!fleet.length) throw new Error('no iPhone simulators available');

fleet.forEach((d, i) => {
  phones.push({
    udid: d.udid,
    name: d.name,
    errand: ERRANDS[i % ERRANDS.length]!,
    state: d.booted ? 'installing' : 'booting',
    shot: null,
  });
});

const server = Bun.serve({
  port: PORT,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/state') {
      return Response.json({
        phones: phones.map((p) => ({
          udid: p.udid,
          name: p.name,
          state: p.state,
          task: p.errand.label,
          hasShot: p.shot !== null,
        })),
      });
    }
    const shot = url.pathname.match(/^\/shot\/(.+)$/);
    if (shot) {
      const p = phones.find((x) => x.udid === shot[1]);
      if (p?.shot) return new Response(p.shot, { headers: { 'content-type': 'image/png' } });
      return new Response('no frame', { status: 404 });
    }
    return new Response(page(), { headers: { 'content-type': 'text/html' } });
  },
});

console.log(`\n  the wall is live →  http://localhost:${PORT}\n`);
console.log(`  ${phones.length} iPhones:`);
for (const p of phones) console.log(`    ${p.name.padEnd(20)} ${p.errand.label}`);
console.log('');

const stop = { done: false };
const APPS: Record<string, string> = {
  Wikipedia: `${process.env.HOME}/Dev/demo-apps/Wikipedia.app`,
  'Ice Cubes': `${process.env.HOME}/Dev/demo-apps/Ice Cubes.app`,
  Cinephile: `${process.env.HOME}/Dev/demo-apps/Cinephile.app`,
};

await Promise.all(
  phones.map(async (phone) => {
    void captureLoop(phone, stop);
    try {
      if (phone.state === 'booting') {
        await $`xcrun simctl boot ${phone.udid}`.quiet().nothrow();
        await $`xcrun simctl bootstatus ${phone.udid} -b`.quiet().nothrow();
      }
      const app = APPS[phone.errand.app];
      if (app) {
        phone.state = 'installing';
        await $`xcrun simctl install ${phone.udid} ${app}`.quiet().nothrow();
      }
      phone.state = 'working';
      await phone.errand.run(phone.udid);
      phone.state = 'done';
    } catch {
      phone.state = 'failed';
    }
  }),
);

console.log('  every phone finished. the wall stays live — ctrl-c to stop.\n');
// Keep serving so the finished screens remain on the wall.
await new Promise(() => {});
void server;
