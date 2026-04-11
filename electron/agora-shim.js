
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
