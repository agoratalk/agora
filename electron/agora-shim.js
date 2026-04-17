/**
 * agora-shim.js — Browser/WebSocket compatibility shim.
 *
 * This shim is injected into pages opened via a plain browser (not inside
 * Electron).  In Electron, the `window.agora` API is provided natively by
 * the preload script over contextBridge/ipcRenderer.  This shim provides the
 * same API surface by connecting to the daemon's IPC port through a WebSocket
 * (the Electron main process exposes a WebSocket bridge at ws://localhost/ipc
 * for the browser preview path).
 *
 * ## API surface exposed as `window.agora`
 *
 *   agora.request(method, params) → Promise
 *     Sends a JSON-RPC request and returns a promise that resolves with the
 *     response.  Requests are correlated by a monotonically-increasing `id`.
 *     Times out after 8 seconds.
 *
 *   agora.onEvent(callback)
 *     Register a listener for unsolicited daemon events (new DM, like, etc.).
 *     Multiple listeners are supported; all are called for every event.
 *
 *   agora.windowControl()
 *     No-op in browser context (window controls are native in Electron).
 */

(function(){
  // Incrementing request ID counter — used to match responses to requests.
  let ws, reqId = 1;

  // Map of pending request ID → resolve callback.
  // When a response arrives, we look up the callback, call it, and delete it.
  const pending = new Map();

  // List of event listeners registered via `onEvent`.
  const eventCbs = [];

  /**
   * Connect (or reconnect) to the WebSocket IPC bridge.
   * Reconnects automatically after 1.5 s on close so transient failures
   * (daemon restart, temporary network blip) are recovered transparently.
   */
  function connect() {
    ws = new WebSocket('ws://' + location.host + '/ipc');

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.event) {
          // Unsolicited daemon event — fan out to all registered listeners.
          eventCbs.forEach(cb => cb(msg));
        } else if (msg.id !== undefined) {
          // Response to a pending request — resolve the matching promise.
          const cb = pending.get(msg.id);
          if (cb) { pending.delete(msg.id); cb(msg); }
        }
      } catch(err) { console.error(err); }
    };

    // On close, wait 1.5 s then reconnect.
    ws.onclose = () => setTimeout(connect, 1500);
  }

  // Establish the initial connection.
  connect();

  // ── Public API ──────────────────────────────────────────────────────────────

  window.agora = {
    /**
     * Send a JSON-RPC request to the daemon and return a Promise.
     *
     * If the WebSocket isn't open yet, the send is retried every 100 ms until
     * it is (e.g., during initial connection).  The promise is rejected after
     * 8 seconds regardless so the UI never hangs indefinitely.
     *
     * @param {string} method   - RPC method name (e.g. "whoami", "peers")
     * @param {object} params   - Method parameters object
     * @returns {Promise<object>} - Resolves with the full IPC response object
     */
    request: (method, params) => new Promise((resolve, reject) => {
      const id = reqId++;
      pending.set(id, resolve);

      // Retry sending until the socket is open (readyState === 1 = OPEN).
      const send = () => ws.readyState === 1
        ? ws.send(JSON.stringify({id, method, params}))
        : setTimeout(send, 100);
      send();

      // Timeout: clean up the pending entry and reject after 8 seconds.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('timeout'));
        }
      }, 8000);
    }),

    /**
     * Register a callback for unsolicited daemon events.
     * The callback receives the full event object: `{ event: string, data: … }`.
     *
     * @param {function} cb - Event handler
     */
    onEvent: (cb) => eventCbs.push(cb),

    /**
     * No-op in browser context — window minimize/maximize/close are handled
     * by the native Electron window controls in the desktop app.
     */
    windowControl: () => {},
  };
})();
