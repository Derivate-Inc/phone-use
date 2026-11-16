import * as driver from './driver.ts';
import { getGraph, onGraph } from './vizbus.ts';

// The screen streams as MJPEG (continuous JPEG frames) so the browser renders
// it as smooth video; the cursor and element boxes are a separate SVG overlay
// updated over SSE and CSS-animated at 60fps. Alongside it, the app map draws
// itself as the agent crawls (graph state pushed over a second SSE channel and
// laid out client-side). Decoupling render from capture keeps both smooth.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Phone Use — live</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0a0c10; color:#c9d1d9;
         font:13px -apple-system,system-ui,sans-serif;
         display:flex; flex-direction:column; align-items:center; gap:14px; padding:22px; }
  h1 { font-size:13px; font-weight:600; letter-spacing:.08em; color:#8b98a5; margin:2px 0; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#3fb950;
         margin-right:7px; vertical-align:middle; box-shadow:0 0 8px #3fb950; animation:blink 1.6s infinite; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
  #stage { position:relative; border-radius:26px; overflow:hidden;
           box-shadow:0 16px 60px rgba(0,0,0,.7); outline:1px solid #1c2128; background:#000; }
  #screen { display:block; max-height:80vh; }
  #overlay { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
  .box { fill:none; stroke:rgba(0,150,255,.5); stroke-width:1; }
  .box.i { stroke:rgba(0,170,255,.75); }
  .box.hot { stroke:#ff5a28; stroke-width:2.5; fill:rgba(255,90,40,.08); }
  #cursor { transition: transform .13s cubic-bezier(.22,.61,.36,1); }
  #pulse { opacity:0; }
  #status { font-size:12px; color:#586069; font-variant-numeric:tabular-nums; }
  #wrap { display:flex; gap:24px; align-items:flex-start; flex-wrap:wrap; justify-content:center; }
  #atlas-panel { display:flex; flex-direction:column; gap:8px; }
  #atlas { width:min(560px,46vw); height:80vh; background:#0b111c; border-radius:16px;
           outline:1px solid #1c2937; box-shadow:0 16px 60px rgba(0,0,0,.5); }
  .cap { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:#5b6b80; }
  .gedge { stroke:#2f5f96; stroke-width:1.4; fill:none; opacity:.85; }
  .gedge.act { stroke:#e6ad55; stroke-width:2.4; opacity:1; }
  .gnode { fill:#101f38; stroke:#2b4d7d; stroke-width:1.4; }
  .gnode.root { fill:#1592b4; stroke:#3fc3e0; }
  .gnode.cur { stroke:#e6ad55; stroke-width:2.6; }
  .glabel { fill:#dbe8f7; font:600 12px -apple-system,system-ui,sans-serif; }
  .glabel.root { fill:#fff; }
  .gedgelabel { fill:#7fa8d6; font:10px ui-monospace,Menlo,monospace; }
</style></head>
<body>
  <h1><span class="dot"></span>PHONE USE — LIVE</h1>
  <div id="wrap">
    <div id="stage">
      <img id="screen" src="/stream" alt="screen"/>
      <svg id="overlay" preserveAspectRatio="none"></svg>
    </div>
    <div id="atlas-panel">
      <div class="cap" id="atlas-cap">ATLAS — waiting for a crawl…</div>
      <svg id="atlas" preserveAspectRatio="xMidYMin meet"></svg>
    </div>
  </div>
  <div id="status">connecting…</div>
<script>
  const overlay = document.getElementById('overlay');
  const status = document.getElementById('status');
  const NS = 'http://www.w3.org/2000/svg';
  let fps = 0, frames = 0, last = performance.now();

  // Count MJPEG frames by watching the img load ticks isn't reliable; estimate
  // via periodic status and rely on SSE ticks for state freshness.
  const es = new EventSource('/state');
  es.onmessage = (e) => { render(JSON.parse(e.data)); };
  es.onerror = () => { status.textContent = 'reconnecting…'; };

  function el(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function render(s) {
    const vw = s.viewport.width, vh = s.viewport.height;
    overlay.setAttribute('viewBox', '0 0 ' + vw + ' ' + vh);

    // Boxes (rebuilt each state) + persistent cursor/pulse.
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    for (const b of s.boxes) {
      const cls = 'box' + (b.ref === s.hoveredRef ? ' hot' : (b.interactive ? ' i' : ''));
      overlay.appendChild(el('rect', { x:b.x, y:b.y, width:b.width, height:b.height, rx:4, class:cls }));
    }
    if (s.pulse && Date.now() - s.pulse.at < 700) {
      overlay.appendChild(el('circle', { cx:s.pulse.x, cy:s.pulse.y, r:6, fill:'none',
        stroke:'#ff5a28', 'stroke-width':2 }));
      const ring = el('circle', { cx:s.pulse.x, cy:s.pulse.y, r:6, fill:'none',
        stroke:'#ff5a28', 'stroke-width':2 });
      const anim = el('animate', { attributeName:'r', from:'6', to:'26', dur:'.5s', fill:'freeze' });
      const anim2 = el('animate', { attributeName:'opacity', from:'.9', to:'0', dur:'.5s', fill:'freeze' });
      ring.appendChild(anim); ring.appendChild(anim2); overlay.appendChild(ring);
    }
    // Cursor pointer (tip at cursor point), transform-animated for smooth glide.
    const g = el('g', { id:'cursor', transform:'translate(' + s.cursor.x + ',' + s.cursor.y + ') scale(1.4)' });
    g.appendChild(el('path', { d:'M0,0 L0,18 L5,13.5 L8.5,21 L11.5,19.6 L8,12.3 L14,12.3 Z',
      fill:'rgba(0,0,0,.35)', transform:'translate(.8,.8)' }));
    g.appendChild(el('path', { d:'M0,0 L0,18 L5,13.5 L8.5,21 L11.5,19.6 L8,12.3 L14,12.3 Z',
      fill:'#fff', stroke:'#141414', 'stroke-width':1.1, 'stroke-linejoin':'round' }));
    overlay.appendChild(g);

    status.textContent = 'cursor (' + s.cursor.x + ', ' + s.cursor.y + ')  ·  ' +
      s.boxes.length + ' elements' + (s.hoveredRef ? '  ·  ' + s.hoveredRef : '');
  }

  // --- Live atlas: draw the app map as it's crawled -----------------------
  const atlas = document.getElementById('atlas');
  const atlasCap = document.getElementById('atlas-cap');
  const gs = new EventSource('/graph');
  gs.onmessage = (e) => drawGraph(JSON.parse(e.data));

  function drawGraph(g) {
    while (atlas.firstChild) atlas.removeChild(atlas.firstChild);
    if (!g.nodes.length) { atlasCap.textContent = 'ATLAS — waiting for a crawl…'; return; }
    atlasCap.textContent = 'ATLAS · ' + (g.app || '') + ' · ' + g.nodes.length + ' screens';

    // Layered layout: group by depth, spread each row horizontally.
    const byDepth = {};
    for (const n of g.nodes) (byDepth[n.depth] = byDepth[n.depth] || []).push(n);
    const depths = Object.keys(byDepth).map(Number).sort((a,b)=>a-b);
    const NW = 128, NH = 34, ROW = 92, PADX = 20, PADY = 24;
    const pos = {};
    let maxW = 0;
    for (const d of depths) maxW = Math.max(maxW, byDepth[d].length * (NW + 16));
    for (const d of depths) {
      const row = byDepth[d];
      const rowW = row.length * (NW + 16) - 16;
      let x = PADX + (maxW - rowW) / 2;
      const y = PADY + d * ROW;
      for (const n of row) { pos[n.sig] = { x: x + NW/2, y, cx:x, w:NW }; x += NW + 16; }
    }
    const W = maxW + PADX*2, H = PADY*2 + (depths.length-1)*ROW + NH;
    atlas.setAttribute('viewBox', '0 0 ' + W + ' ' + Math.max(H, 120));

    for (const e of g.edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b || e.from === e.to) continue;
      const act = g.current === e.to && g.visiting === e.label;
      const y1 = a.y + NH, y2 = b.y, my = (y1+y2)/2;
      atlas.appendChild(el('path', { d:'M'+a.x+' '+y1+' C '+a.x+' '+my+', '+b.x+' '+my+', '+b.x+' '+y2,
        class: 'gedge' + (act ? ' act' : '') }));
    }
    for (const n of g.nodes) {
      const p = pos[n.sig]; if (!p) continue;
      const isRoot = n.depth === 0, isCur = g.current === n.sig;
      atlas.appendChild(el('rect', { x:p.cx, y:p.y, width:p.w, height:NH, rx:8,
        class:'gnode' + (isRoot?' root':'') + (isCur?' cur':'') }));
      const t = (n.title || 'screen').slice(0, 16);
      const txt = el('text', { x:p.x, y:p.y + NH/2 + 4, 'text-anchor':'middle', class:'glabel'+(isRoot?' root':'') });
      txt.textContent = t;
      atlas.appendChild(txt);
    }
  }
</script>
</body></html>`;

const JPEG_BOUNDARY = 'phoneuseframe';

export function startLiveViewer(port: number): void {
  const stateClients = new Set<ReadableStreamDefaultController>();
  const graphClients = new Set<ReadableStreamDefaultController>();
  const enc = new TextEncoder();

  driver.onState((s) => {
    const msg = enc.encode(`data: ${JSON.stringify(s)}\n\n`);
    for (const c of stateClients) {
      try {
        c.enqueue(msg);
      } catch {
        stateClients.delete(c);
      }
    }
  });

  onGraph((g) => {
    const msg = enc.encode(`data: ${JSON.stringify(g)}\n\n`);
    for (const c of graphClients) {
      try {
        c.enqueue(msg);
      } catch {
        graphClients.delete(c);
      }
    }
  });

  // Loopback only: the stream is the phone's screen and there is no auth.
  // PHONE_USE_LIVE_HOST=0.0.0.0 opts into exposing it (e.g. inside a VM).
  const hostname = process.env.PHONE_USE_LIVE_HOST ?? '127.0.0.1';
  Bun.serve({
    hostname,
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/') {
        return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
      }

      // MJPEG screen video — continuous JPEG frames captured fast via simctl.
      if (url.pathname === '/stream') {
        let alive = true;
        req.signal.addEventListener('abort', () => (alive = false));
        const stream = new ReadableStream({
          async pull(controller) {
            if (!alive) {
              controller.close();
              return;
            }
            const jpeg = await driver.captureFastJpeg();
            if (jpeg) {
              controller.enqueue(
                enc.encode(
                  `--${JPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
                ),
              );
              controller.enqueue(jpeg);
              controller.enqueue(enc.encode('\r\n'));
            }
            await Bun.sleep(90); // ~9-10 fps ceiling from ~110ms capture
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': `multipart/x-mixed-replace; boundary=${JPEG_BOUNDARY}`,
            'cache-control': 'no-cache',
          },
        });
      }

      // SSE overlay state — cursor, boxes, pulse (point space).
      if (url.pathname === '/state') {
        const stream = new ReadableStream({
          start(controller) {
            stateClients.add(controller);
            controller.enqueue(enc.encode(`data: ${JSON.stringify(driver.getLiveState())}\n\n`));
          },
          cancel() {
            /* dropped */
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }

      // SSE crawl graph — the app map as it's discovered (laid out client-side).
      if (url.pathname === '/graph') {
        const stream = new ReadableStream({
          start(controller) {
            graphClients.add(controller);
            controller.enqueue(enc.encode(`data: ${JSON.stringify(getGraph())}\n\n`));
          },
          cancel() {
            /* dropped */
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }

      return new Response('not found', { status: 404 });
    },
  });

  console.error(`phone-use live viewer → http://${hostname}:${port}`);
}
