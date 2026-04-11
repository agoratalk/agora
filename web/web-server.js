// Minimal HTTP + WebSocket bridge: serves index.html and proxies browser
// WebSocket messages <-> daemon's newline-delimited JSON TCP IPC on :7779.
const http = require('http');
const fs   = require('fs');
const path = require('path');
const net  = require('net');
const { WebSocketServer } = require('ws');

const WEB_PORT  = parseInt(process.env.WEB_PORT || '8080', 10);
const IPC_PORT  = 7779;
const IPC_HOST  = '127.0.0.1';
const ROOT      = path.join(__dirname, '..', 'electron');

// ── HTTP: serve index.html + shim.js ──────────────────────────────────────────
const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(full);
    const type = ext === '.html' ? 'text/html'
               : ext === '.js'   ? 'application/javascript'
               : ext === '.css'  ? 'text/css' : 'application/octet-stream';
    // Inject the shim into index.html so the existing renderer sees window.agora
    if (ext === '.html') {
      const shim = '<script src="/agora-shim.js"></script></head>';
      data = Buffer.from(data.toString().replace('</head>', shim));
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

// ── WebSocket <-> TCP IPC bridge ──────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ipc' });
wss.on('connection', (ws) => {
  const sock = new net.Socket();
  let buf = '';
  sock.connect(IPC_PORT, IPC_HOST);
  sock.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) if (l.trim()) ws.send(l);
  });
  sock.on('error', (e) => ws.send(JSON.stringify({ event: 'ipc_error', data: e.message })));
  sock.on('close', () => ws.close());
  ws.on('message', (msg) => { try { sock.write(msg.toString() + '\n'); } catch {} });
  ws.on('close', () => sock.destroy());
});

// ── Shim served to browser: exposes window.agora (same API as Electron preload)
const SHIM = `
(function(){
  let ws, reqId = 1, pending = new Map(), eventCbs = [];
  function connect() {
    ws = new WebSocket('ws://' + location.host + '/ipc');
    ws.onmessage = (e) => {
      try { const msg = JSON.parse(e.data);
        if (msg.event) { eventCbs.forEach(cb => cb(msg)); }
        else if (msg.id !== undefined) { const cb = pending.get(msg.id); if (cb) { pending.delete(msg.id); cb(msg); } }
      } catch(err) { console.error(err); }
    };
    ws.onclose = () => setTimeout(connect, 1500);
  }
  connect();
  window.agora = {
    request: (method, params) => new Promise((resolve, reject) => {
      const id = reqId++;
      pending.set(id, resolve);
      const send = () => ws.readyState === 1 ? ws.send(JSON.stringify({id, method, params})) : setTimeout(send, 100);
      send();
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 8000);
    }),
    onEvent: (cb) => eventCbs.push(cb),
    windowControl: () => {}, // no-op in browser
  };
})();
`;
fs.writeFileSync(path.join(ROOT, 'agora-shim.js'), SHIM);

server.listen(WEB_PORT, '0.0.0.0', () => console.log('web bridge on :' + WEB_PORT));
