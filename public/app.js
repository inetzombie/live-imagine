const $ = id => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d');
let finalBlob = null, busy = false;

// ---------- IndexedDB history ----------
const db = await new Promise((ok, no) => { const r = indexedDB.open('live-imagine', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('gens', { keyPath: 'id', autoIncrement: true });
  r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const tx = (m) => db.transaction('gens', m).objectStore('gens');
const addGen = g => new Promise(ok => { tx('readwrite').add(g).onsuccess = ok; });
const allGens = () => new Promise(ok => { tx('readonly').getAll().onsuccess = e => ok(e.target.result.reverse()); });
async function renderGallery() {
  const g = $('gallery'); g.innerHTML = '';
  for (const it of (await allGens()).slice(0, 40)) {
    const im = new Image(); im.src = URL.createObjectURL(it.blob); im.title = it.prompt;
    im.onclick = () => { drawBlob(it.blob); finalBlob = it.blob; $('dl').disabled = false; $('prompt').value = it.prompt; $('seed').value = it.seed ?? ''; $('overlay').classList.add('hide'); $('hudStep').textContent = 'from history'; };
    g.append(im);
  }
}

// ---------- canvas ----------
async function drawBlob(blob) { const bmp = await createImageBitmap(blob);
  if (cv.width !== bmp.width || cv.height !== bmp.height) { cv.width = bmp.width; cv.height = bmp.height; }
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height); }
async function drawUrl(url) { const r = await fetch(url); const b = await r.blob(); await drawBlob(b); return b; }

// ---------- status ----------
let configured = false;
fetch('/api/health').then(r => r.json()).then(j => { configured = j.configured;
  const s = $('status'); s.textContent = configured ? `live · ${j.model}` : 'API key not configured';
  s.className = 'pill ' + (configured ? 'ok' : 'bad');
  if (!configured) msg('API key not configured: the site owner needs to add FAL_KEY in Vercel. See README.', true);
}).catch(() => { $('status').textContent = 'backend unreachable'; $('status').className = 'pill bad'; });
function msg(t, err) { $('msg').textContent = t; $('msg').className = 'msg' + (err ? ' err' : ''); }

// pull every image URL out of an arbitrary fal event
function imagesIn(ev) { const out = [];
  (function walk(o) { if (!o || typeof o !== 'object') return;
    if (typeof o.url === 'string' && (o.content_type?.startsWith('image') || /^data:image|\.(png|jpe?g|webp)/i.test(o.url))) out.push(o.url);
    for (const v of Object.values(o)) walk(v); })(ev); return out; }

// ---------- generate ----------
$('f').onsubmit = async e => { e.preventDefault(); if (busy) return;
  if (!configured) { msg('API key not configured: cannot generate yet.', true); return; }
  busy = true; $('go').disabled = true; $('dl').disabled = true; finalBlob = null; $('strip').innerHTML = '';
  $('overlay').classList.add('hide'); $('frame').classList.add('live'); msg('Connecting…');
  ctx.fillStyle = '#050506'; ctx.fillRect(0, 0, cv.width, cv.height);
  const t0 = performance.now(), tick = setInterval(() => $('hudTime').textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's', 100);
  const body = { prompt: $('prompt').value, negative: $('neg').value, aspect: $('aspect').value, steps: +$('steps').value, seed: $('seed').value };
  let frames = 0, last = null, lastEv = null;
  try {
    const r = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || j.error || r.statusText); }
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'); if (!data) continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; } lastEv = ev;
        if (ev.message && /error/i.test(chunk)) throw new Error(ev.message);
        for (const u of imagesIn(ev)) { if (u === last) continue; last = u; frames++;
          const b = await drawUrl(u); finalBlob = b;
          $('hudStep').textContent = `frame ${frames}`; msg(`Streaming real intermediate frames… (${frames})`);
          const th = new Image(); th.src = URL.createObjectURL(b); $('strip').append(th); th.scrollIntoView({ inline: 'end', block: 'nearest' }); } } }
    if (!finalBlob) throw new Error('No image returned.');
    finalBlob = await new Promise(ok => cv.toBlob(ok, 'image/png'));
    $('hudStep').textContent = `done · ${frames} frame${frames > 1 ? 's' : ''}`;
    msg(frames > 1 ? 'Done.' : 'Done (the API sent only the final image this time; no intermediates).');
    $('dl').disabled = false;
    await addGen({ prompt: body.prompt, seed: lastEv?.seed ?? body.seed, created: Date.now(), blob: finalBlob }); renderGallery();
  } catch (err) { msg('Error: ' + err.message, true); $('hudStep').textContent = 'error'; }
  clearInterval(tick); busy = false; $('go').disabled = false; $('frame').classList.remove('live'); };

$('dl').onclick = () => { if (!finalBlob) return; const a = document.createElement('a');
  a.href = URL.createObjectURL(finalBlob); a.download = `live-imagine-${Date.now()}.png`; a.click(); };
renderGallery();
