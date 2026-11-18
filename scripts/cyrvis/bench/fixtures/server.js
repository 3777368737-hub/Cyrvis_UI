/*
 * CYRVIS GUI benchmark fixture server.
 * Local-only pages for L3/L4/L5; success oracles are written to JSON so the
 * harness never has to trust the agent's self-report.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 8765;
const BENCH_DIR = 'D:\\temp\\cyrvis-bench';
const STATE_PATH = path.join(BENCH_DIR, 'server-state.json');
fs.mkdirSync(BENCH_DIR, { recursive: true });

const state = {
  run: 0,
  query: null,
  searchVisits: 0,
  detailVisits: [],
  detailCode: null,
  shortCode: null,
  submissions: [],
  updatedAt: null,
};

function save() {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function resetState() {
  state.run += 1;
  state.query = null;
  state.searchVisits = 0;
  state.detailVisits = [];
  state.detailCode = `PARIS-${1000 + Math.floor(Math.random() * 9000)}`;
  state.shortCode = String(100000 + Math.floor(Math.random() * 900000));
  state.submissions = [];
  save();
  return state;
}
resetState();

const style = `
  body { font-family: "Segoe UI", Arial, sans-serif; margin: 0; padding: 36px 44px;
         background: #f4f6f8; color: #172033; }
  h1 { font-size: 34px; margin: 0 0 24px; }
  input { font-size: 26px; padding: 12px 14px; width: 420px; border: 2px solid #9aa7b8;
          border-radius: 8px; }
  button { font-size: 26px; padding: 12px 24px; margin-left: 12px; border: 0;
           border-radius: 8px; background: #1c64f2; color: white; cursor: pointer; }
  .result { background: white; border-radius: 10px; padding: 18px 22px; margin: 14px 0;
            box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .result a { font-size: 24px; color: #0f4ecf; text-decoration: none; }
  .result p { margin: 8px 0 0; font-size: 18px; color: #4b5b70; }
  .code { font-size: 56px; letter-spacing: 6px; font-weight: 700; margin-top: 26px;
          color: #0f4ecf; }
  .muted { color: #6b7a90; font-size: 20px; }
`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <title>${title}</title><style>${style}</style></head><body>${body}</body></html>`;
}

function searchPage() {
  return page(
    'CYRVIS Local Search',
    `<h1>CYRVIS Local Search</h1>
     <form action="/search" method="get">
       <input name="q" id="q" placeholder="Search..." autofocus>
       <button type="submit">Search</button>
     </form>`,
  );
}

function resultsPage(q) {
  const rows = Array.from({ length: 10 }, (_, index) => {
    const id = index + 1;
    return `<div class="result">
      <a href="/detail/${id}" target="_blank">${id}. Paris Travel Guide — Result ${id}</a>
      <p>Local fixture result ${id} for "${q}". Open this result for details.</p>
    </div>`;
  }).join('');
  return page(
    `Results for ${q}`,
    `<h1>Results for "${q}"</h1>${rows}`,
  );
}

function detailPage(id) {
  if (id === 3) {
    return page(
      'Result 3 — Paris Travel Guide',
      `<h1>Result 3 — Paris Travel Guide</h1>
       <p class="muted">Pickup code / 取件码</p>
       <div class="code">${state.detailCode}</div>`,
    );
  }
  return page(
    `Result ${id}`,
    `<h1>Result ${id}</h1>
     <p class="muted">No pickup code on this page.</p>`,
  );
}

function codePage() {
  return page(
    'CYRVIS Pickup Code',
    `<h1>CYRVIS Pickup Code</h1>
     <p class="muted">取件码 / Pickup code</p>
     <div class="code">${state.shortCode}</div>`,
  );
}

function formPage() {
  return page(
    'CYRVIS Benchmark Form',
    `<h1>CYRVIS Benchmark Form</h1>
     <form id="f">
       <p><label>Name <input id="name" name="name"></label></p>
       <p><label>Email <input id="email" name="email"></label></p>
       <button type="submit">Submit</button>
     </form>
     <div id="result" class="code" style="font-size:32px"></div>
     <script>
       document.getElementById('f').addEventListener('submit', async (e) => {
         e.preventDefault();
         const name = document.getElementById('name').value;
         const email = document.getElementById('email').value;
         const res = await fetch('/submit', {
           method: 'POST',
           headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({name, email}),
         });
         const data = await res.json();
         document.getElementById('result').textContent =
           data.ok ? 'Submitted' : 'Failed';
       });
     </script>`,
  );
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (p === '/health') {
    return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
  }
  if (p === '/state') {
    return send(res, 200, JSON.stringify(state), 'application/json');
  }
  if (p === '/reset') {
    return send(res, 200, JSON.stringify(resetState()), 'application/json');
  }
  if (p === '/search.html') {
    return send(res, 200, searchPage());
  }
  if (p === '/search') {
    const q = url.searchParams.get('q') || '';
    state.query = q;
    state.searchVisits += 1;
    save();
    return send(res, 200, resultsPage(q));
  }
  const detailMatch = p.match(/^\/detail\/(\d+)$/);
  if (detailMatch) {
    const id = Number(detailMatch[1]);
    state.detailVisits.push(id);
    save();
    return send(res, 200, detailPage(id));
  }
  if (p === '/code.html') {
    return send(res, 200, codePage());
  }
  if (p === '/form.html') {
    return send(res, 200, formPage());
  }
  if (p === '/submit' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = { raw: body };
      }
      state.submissions.push(parsed);
      save();
      send(res, 200, JSON.stringify({ ok: true }), 'application/json');
    });
    return;
  }

  send(res, 404, 'Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bench] fixture server http://127.0.0.1:${PORT}`);
  console.log(`[bench] state ${STATE_PATH}`);
});
