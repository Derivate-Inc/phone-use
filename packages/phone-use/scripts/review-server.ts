// Local review UI for iOSWorld runs: see each task's goal, the agent's reply,
// the judge's rubric score, and the FINAL SCREENSHOT the judge saw — then rate
// it yourself (Pass/Fail). Human ratings append to human-ratings.jsonl and the
// header shows human↔judge agreement, the same validation stat iOSWorld
// published for their judge (89%). Auto-refreshes as the run appends results.
//
//   bun scripts/review-server.ts   → http://localhost:4917

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

// The directory holding the iOSWorld result files to review.
const SP = process.env.REVIEW_RESULTS_DIR;
if (!SP) {
  console.error('Set REVIEW_RESULTS_DIR to the directory with the iosworld-*-results.jsonl files.');
  process.exit(1);
}
const RESULT_FILES = [
  { label: 'full', path: `${SP}/iosworld-46-results.jsonl` },
  { label: 'raw', path: `${SP}/iosworld-46-raw-results.jsonl` },
];
const RATINGS = `${SP}/human-ratings.jsonl`;

type Row = Record<string, unknown> & {
  name: string;
  judge?: number;
  judgeMax?: number;
  ok?: boolean;
  status?: string;
  reply?: string;
  turns?: number;
  ms?: number;
};

function loadRows(): (Row & { surface: string })[] {
  const out: (Row & { surface: string })[] = [];
  for (const f of RESULT_FILES) {
    if (!existsSync(f.path)) continue;
    for (const line of readFileSync(f.path, 'utf8').trim().split('\n').filter(Boolean)) {
      try {
        out.push({ ...(JSON.parse(line) as Row), surface: f.label });
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

function loadRatings(): Record<string, { humanPass: boolean }> {
  const out: Record<string, { humanPass: boolean }> = {};
  if (existsSync(RATINGS)) {
    for (const line of readFileSync(RATINGS, 'utf8').trim().split('\n').filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        out[`${j.surface}:${j.name}`] = j;
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

const server = Bun.serve({
  port: 4917,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/shot') {
      const name = url.searchParams.get('name') ?? '';
      const p = `/tmp/iosworld-judge-${name}.png`;
      if (existsSync(p)) return new Response(Bun.file(p));
      return new Response('no screenshot', { status: 404 });
    }
    if (url.pathname === '/rate' && req.method === 'POST') {
      const body = await req.json();
      appendFileSync(
        RATINGS,
        `${JSON.stringify({ ...(body as Record<string, unknown>), at: new Date().toISOString() })}\n`,
      );
      return Response.json({ ok: true });
    }
    if (url.pathname === '/data') {
      return Response.json({ rows: loadRows(), ratings: loadRatings() });
    }
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});

const PAGE = `<!doctype html><meta charset="utf-8"><title>iOSWorld review</title>
<style>
  :root { --ok:#1a7f37; --bad:#b42318; --dim:#667085; font-family: ui-sans-serif, system-ui; }
  body { margin:0; background:#fafafa; color:#111; }
  header { padding:14px 20px; background:#fff; border-bottom:1px solid #eee; display:flex; gap:24px; align-items:baseline; position:sticky; top:0; }
  h1 { font-size:16px; margin:0; }
  .stat { color:var(--dim); font-size:13px; }
  main { display:grid; grid-template-columns: 340px 1fr; height: calc(100vh - 49px); }
  #list { overflow-y:auto; border-right:1px solid #eee; background:#fff; }
  .item { padding:10px 14px; border-bottom:1px solid #f2f2f2; cursor:pointer; font-size:13px; display:flex; gap:8px; align-items:center; }
  .item:hover { background:#f6f6f6; } .item.sel { background:#eef4ff; }
  .tag { font-size:11px; padding:1px 6px; border-radius:8px; background:#eee; color:var(--dim); }
  .ok { color:var(--ok); font-weight:600; } .bad { color:var(--bad); font-weight:600; }
  #detail { overflow-y:auto; padding:20px 26px; display:grid; grid-template-columns: 1fr 300px; gap:24px; }
  #shot { width:300px; border:1px solid #ddd; border-radius:14px; }
  h2 { font-size:15px; margin:0 0 6px; } .goal { font-size:14px; margin-bottom:14px; }
  .reply { white-space:pre-wrap; background:#fff; border:1px solid #eee; border-radius:8px; padding:12px; font-size:13px; }
  .meta { color:var(--dim); font-size:12.5px; margin:10px 0; }
  .rate { margin-top:16px; display:flex; gap:10px; }
  button { font-size:14px; padding:8px 18px; border-radius:8px; border:1px solid #ddd; background:#fff; cursor:pointer; }
  button.pass { border-color:var(--ok); color:var(--ok); } button.fail { border-color:var(--bad); color:var(--bad); }
  button.chosen { color:#fff; } button.pass.chosen { background:var(--ok); } button.fail.chosen { background:var(--bad); }
</style>
<header><h1>iOSWorld run review</h1><span class="stat" id="summary">loading…</span><span class="stat" id="agree"></span></header>
<main><div id="list"></div><div id="detail"><em style="color:var(--dim)">Select a task</em></div></main>
<script>
let DATA={rows:[],ratings:{}}, SEL=null;
async function refresh(){
  DATA=await (await fetch('/data')).json();
  const g=DATA.rows.filter(r=>r.status==='graded'||r.ok!==undefined);
  const p=g.filter(r=>r.ok).length;
  document.getElementById('summary').textContent=g.length+' graded · '+p+' judge-pass ('+(g.length?Math.round(100*p/g.length):0)+'%)';
  const rated=Object.keys(DATA.ratings).length;
  let agreeN=0, agreeY=0;
  for(const r of g){const key=r.surface+':'+r.name;const h=DATA.ratings[key];if(h){agreeN++;if(h.humanPass===!!r.ok)agreeY++;}}
  document.getElementById('agree').textContent=rated?('you rated '+rated+' · human↔judge agreement '+Math.round(100*agreeY/Math.max(1,agreeN))+'%'):'rate tasks to measure judge agreement';
  const list=document.getElementById('list'); list.innerHTML='';
  for(const r of DATA.rows){
    const key=r.surface+':'+r.name;
    const div=document.createElement('div'); div.className='item'+(SEL===key?' sel':'');
    const verdict=r.status!=='graded'&&r.status?('<span class="tag">'+r.status+'</span>'):(r.ok?'<span class="ok">✓</span>':'<span class="bad">✗</span>');
    const human=DATA.ratings[key]?(DATA.ratings[key].humanPass?' <span class="tag" style="background:#e7f5ec;color:var(--ok)">you: pass</span>':' <span class="tag" style="background:#fdecea;color:var(--bad)">you: fail</span>'):'';
    div.innerHTML=verdict+' <b>'+r.name+'</b> <span class="tag">'+r.surface+'</span> <span class="stat">'+(r.judge??'-')+'/'+(r.judgeMax??'-')+'</span>'+human;
    div.onclick=()=>{SEL=key;show(r);refresh();};
    list.appendChild(div);
  }
}
function show(r){
  const key=r.surface+':'+r.name;
  const d=document.getElementById('detail');
  d.innerHTML='<div><h2>'+r.name+' <span class="tag">'+r.surface+'</span></h2>'
    +'<div class="meta">judge: '+(r.judge??'-')+'/'+(r.judgeMax??'-')+' · '+(r.turns??'?')+' turns · '+Math.round((r.ms??0)/1000)+'s · '+(r.status??'graded')+'</div>'
    +'<h2 style="margin-top:14px">Agent reply</h2><div class="reply">'+(r.reply??'(none)').replace(/</g,'&lt;')+'</div>'
    +'<div class="rate"><button class="pass" id="bp">Pass</button><button class="fail" id="bf">Fail</button></div></div>'
    +'<div><img id="shot" src="/shot?name='+encodeURIComponent(r.name)+'" onerror="this.style.display=\\'none\\'"><div class="meta">final screen (what the judge saw)</div></div>';
  const mark=()=>{const h=DATA.ratings[key];document.getElementById('bp').className='pass'+(h&&h.humanPass?' chosen':'');document.getElementById('bf').className='fail'+(h&&!h.humanPass?' chosen':'');};
  mark();
  document.getElementById('bp').onclick=async()=>{await fetch('/rate',{method:'POST',body:JSON.stringify({surface:r.surface,name:r.name,humanPass:true})});await refresh();show(r);};
  document.getElementById('bf').onclick=async()=>{await fetch('/rate',{method:'POST',body:JSON.stringify({surface:r.surface,name:r.name,humanPass:false})});await refresh();show(r);};
}
refresh(); setInterval(refresh, 15000);
</script>`;

console.log(`review server → http://localhost:${server.port}`);
