/**
 * main.js — Electron main process
 *
 * ## Architecture
 * Electron splits execution into two contexts:
 *
 *   Main process  (this file)  — Node.js, full OS access.
 *     • Creates the BrowserWindow.
 *     • Starts the agora daemon as a child process.
 *     • Maintains a persistent TCP socket to the daemon's IPC port.
 *     • Handles IPC calls from the renderer via ipcMain.handle.
 *     • Manages VPN processes (WireGuard via wg-quick, OpenVPN).
 *
 *   Renderer process (index.html + preload.js) — Chromium sandbox.
 *     • All UI code runs here.
 *     • Communicates with the main process via contextBridge/ipcRenderer.
 *     • Never touches the daemon directly — always goes through the main process.
 *
 * ## IPC flow
 *   renderer:  window.agora.request('method', params)
 *     → preload: ipcRenderer.invoke('daemon-request', method, params)
 *       → main:  ipcMain.handle('daemon-request') → sendToIpc(method, params)
 *         → TCP socket → daemon on port 7779
 *         ← JSON response line
 *       ← resolved Promise
 *     ← resolved Promise (renderer)
 *
 * ## Events (daemon → renderer)
 * The daemon pushes unsolicited JSON event objects (new DM, like, peer update).
 * The main process receives them on the TCP socket and forwards them to the
 * renderer via `mainWindow.webContents.send('daemon-event', msg)`.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const net  = require('net');
const { spawn } = require('child_process');

// ── Config ─────────────────────────────────────────────────────────────────────

/// Port the agora daemon's IPC server listens on.
const IPC_PORT = 7779;

/// Platform-specific daemon binary name.
const DAEMON_BIN = process.platform === 'win32' ? 'agora.exe' : 'agora';

// Daemon binary lookup order:
//   1. <resources>/bin/agora  — packaged Electron app
//   2. ../daemon/target/release/agora  — development build
//   3. PATH  — last resort (user installed agora system-wide)
const DAEMON_PATH     = path.join(process.resourcesPath || __dirname, 'bin', DAEMON_BIN);
const DAEMON_DEV_PATH = path.join(__dirname, '..', 'daemon', 'target', 'release', DAEMON_BIN);

/// Reference to the Electron BrowserWindow instance.
let mainWindow;

/// Child process handle for the agora daemon.  null when not running.
let daemonProc  = null;

/// TCP socket to the daemon's IPC server.  null when not connected.
let ipcSocket   = null;

// ── VPN state ─────────────────────────────────────────────────────────────────
// VPN connections are managed directly from the main process because they
// require spawning privileged child processes.

/// Long-running VPN process handle (used for OpenVPN; null for wg-quick which
/// exits after configuring the interface).
let vpnProc       = null;
/// Currently active VPN type: 'WireGuard' | 'OpenVPN' | null
let vpnType       = null;
/// Path to the temporary VPN config file written to userData.
let vpnConfigPath = null;

// ── IPC socket state ───────────────────────────────────────────────────────────

/// Receive buffer for partial TCP data (lines may arrive split across chunks).
let ipcBuffer = '';
/// Monotonically-increasing request ID for correlating IPC responses.
let ipcReqId = 1;
/// Map of request ID → resolve callback for pending IPC requests.
const pendingRequests = new Map();

// ── Window ─────────────────────────────────────────────────────────────────────

/**
 * Create the main application window.
 *
 * - Frameless window with a custom titlebar rendered in HTML/CSS.
 * - contextIsolation: true + nodeIntegration: false = secure renderer sandbox.
 * - preload.js is the only bridge between renderer and main process.
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 780,
    minHeight: 500,
    frame: false,               // custom HTML titlebar instead of OS chrome
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0f14', // matches CSS --bg0 to prevent flash of white
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // isolates renderer from Node.js globals
      nodeIntegration: false,   // renderer cannot require() Node modules directly
    },
  });
  mainWindow.loadFile('index.html');
}

// ── Daemon management ──────────────────────────────────────────────────────────

/**
 * Start the agora daemon as a child process.
 *
 * Log level is set to 'warn' so the daemon doesn't spam the Electron console
 * with info-level messages during normal operation.
 *
 * If the daemon binary can't be found at any of the expected paths, a warning
 * is printed and the user is told to start it manually.  The rest of the app
 * still loads; it will just show a "not connected" state until the daemon is
 * running.
 */
function startDaemon() {
  const fs = require('fs');
  // Try paths in order: packaged → dev build → system PATH
  const binPath = fs.existsSync(DAEMON_PATH) ? DAEMON_PATH
               : fs.existsSync(DAEMON_DEV_PATH) ? DAEMON_DEV_PATH
               : DAEMON_BIN; // last resort: PATH

  try {
    daemonProc = spawn(binPath, ['--log', 'warn'], {
      detached: false,           // daemon is a child of Electron; dies when Electron dies
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemonProc.stdout.on('data', d => console.log('[daemon]', d.toString().trim()));
    daemonProc.stderr.on('data', d => console.error('[daemon]', d.toString().trim()));
    daemonProc.on('exit', code => {
      console.log(`[daemon] exited with code ${code}`);
      daemonProc = null;
    });
  } catch (e) {
    console.warn('[daemon] could not start daemon automatically:', e.message);
    console.warn('[daemon] please start agora manually before launching the GUI');
  }
}

// ── IPC connection to daemon ───────────────────────────────────────────────────

/**
 * Connect to the daemon's TCP IPC server and set up event routing.
 *
 * Messages from the daemon come as newline-delimited JSON lines.
 * We accumulate data in `ipcBuffer`, split on `\n`, and process complete lines.
 *
 * Two types of incoming messages:
 *   - Event objects (`msg.event` is set): forwarded to the renderer as
 *     'daemon-event' IPC messages.
 *   - Response objects (`msg.id` is set): looked up in `pendingRequests` and
 *     the corresponding Promise is resolved.
 *
 * @param {number} retries - How many more times to retry on error (default 10)
 */
function connectToIpc(retries = 10) {
  ipcSocket = new net.Socket();

  ipcSocket.on('data', chunk => {
    // Accumulate received bytes.  TCP may deliver data in arbitrary chunks
    // so we must buffer until we have a complete newline-terminated line.
    ipcBuffer += chunk.toString();
    const lines = ipcBuffer.split('\n');
    ipcBuffer = lines.pop(); // last element may be incomplete — keep it for the next chunk
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event) {
          // Unsolicited event — forward to renderer process.
          mainWindow?.webContents.send('daemon-event', msg);
        } else if (msg.id !== undefined) {
          // Response to a pending request — resolve the promise.
          const cb = pendingRequests.get(msg.id);
          if (cb) { pendingRequests.delete(msg.id); cb(msg); }
        }
      } catch (e) { console.error('IPC parse error:', e.message); }
    }
  });

  ipcSocket.on('error', () => {
    // Retry with exponential-ish back-off.  The daemon may still be starting.
    if (retries > 0) {
      setTimeout(() => connectToIpc(retries - 1), 600);
    } else {
      // Notify the renderer so it can show a "connection failed" state.
      mainWindow?.webContents.send('daemon-event', { event: 'connection_failed', data: {} });
    }
  });

  ipcSocket.on('close', () => {
    ipcSocket = null;
    // Reconnect after a short delay to handle transient disconnections.
    setTimeout(() => connectToIpc(5), 2000);
  });

  ipcSocket.connect(IPC_PORT, '127.0.0.1');
}

/**
 * Send a JSON-RPC request to the daemon over the TCP socket.
 *
 * Returns a Promise that resolves with the daemon's response object.
 * Rejects after 8 seconds if no response is received (timeout guard).
 *
 * @param {string} method  - Daemon method name
 * @param {object} params  - Request parameters
 * @returns {Promise<object>}
 */
function sendToIpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ipcSocket) { reject(new Error('not connected to daemon')); return; }
    const id = ipcReqId++;
    pendingRequests.set(id, resolve);
    // Newline-terminate the JSON object (the daemon's line reader expects it).
    const msg = JSON.stringify({ id, method, params }) + '\n';
    ipcSocket.write(msg);
    // 8-second timeout guard: clean up pending entry and reject if no reply.
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('timeout'));
      }
    }, 8000);
  });
}

// ── IPC handlers (renderer → main) ────────────────────────────────────────────

/**
 * Handle a daemon RPC request forwarded from the renderer process.
 * The renderer calls window.agora.request(method, params) which goes through
 * preload.js → ipcRenderer.invoke('daemon-request') → here.
 */
ipcMain.handle('daemon-request', async (_event, method, params) => {
  try {
    return await sendToIpc(method, params);
  } catch (e) {
    return { id: 0, error: e.message };
  }
});

/**
 * Handle window control events from the custom titlebar.
 * The frameless window has no native controls so the HTML titlebar buttons
 * send these events.
 */
ipcMain.on('window-control', (_event, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  if (action === 'close') mainWindow.close();
});

// ── VPN management ────────────────────────────────────────────────────────────
//
// WireGuard: wg-quick exits after setting up the kernel tunnel.
//   • start: wg-quick up <config.conf>
//   • stop:  wg-quick down <config.conf>
//
// OpenVPN: long-running process, stays alive while tunnel is active.
//   • start: openvpn --config <config.ovpn>
//   • stop:  SIGTERM to the process
//
// Both require elevated privileges on most Linux/macOS systems.
// The app writes the config to <userData>/agora-vpn.{conf,ovpn} (mode 0600)
// and passes the full path to the tool.

/**
 * Tear down any currently-active VPN connection.
 *
 * For WireGuard: runs `wg-quick down <config>` and waits up to 6 s.
 * For OpenVPN: sends SIGTERM to the process and waits up to 3 s.
 *
 * Resets all VPN state variables regardless of success.
 */
async function doStopVpn() {
  if (!vpnType) return;
  const type = vpnType;
  const cfgPath = vpnConfigPath;
  vpnType = null;
  vpnConfigPath = null;

  try {
    if (type === 'WireGuard' && cfgPath) {
      await new Promise(resolve => {
        const p = spawn('wg-quick', ['down', cfgPath], { stdio: 'pipe' });
        p.on('exit', resolve);
        p.on('error', resolve);
        setTimeout(resolve, 6000);  // don't hang forever if wg-quick is stuck
      });
    } else if (vpnProc) {
      vpnProc.kill('SIGTERM');
      await new Promise(resolve => {
        vpnProc?.on('exit', resolve);
        setTimeout(resolve, 3000);
      });
    }
  } catch (e) {
    console.error('[vpn] stop error:', e.message);
  }
  vpnProc = null;
}

/**
 * Start a VPN connection using either WireGuard or OpenVPN.
 *
 * Writes the config to a temporary file in Electron's userData directory
 * (mode 0600 so other users can't read it), then spawns the appropriate tool.
 *
 * WireGuard:
 *   - `wg-quick up <config>` runs, sets up the kernel interface, then exits.
 *   - We wait for the process to exit (code 0 = success).
 *   - The kernel module keeps the tunnel alive after wg-quick exits.
 *   - Times out after 15 s.
 *
 * OpenVPN:
 *   - `openvpn --config <config>` runs as a long-lived daemon.
 *   - We wait 5 s for it to fail on its own; if it's still running, we
 *     assume success.
 *
 * Returns `{ ok: true }` on success or `{ error: string }` on failure.
 */
ipcMain.handle('vpn-start', async (_event, type, configContent) => {
  // Tear down any running VPN first
  await doStopVpn();

  try {
    const userDataDir = app.getPath('userData');
    const ext     = type === 'WireGuard' ? '.conf' : '.ovpn';
    const cfgPath = path.join(userDataDir, `agora-vpn${ext}`);

    // Write config with restricted permissions to protect credentials.
    fs.writeFileSync(cfgPath, configContent, { mode: 0o600 });
    vpnConfigPath = cfgPath;
    vpnType = type;

    const [cmd, args] = type === 'WireGuard'
      ? ['wg-quick', ['up', cfgPath]]
      : ['openvpn', ['--config', cfgPath, '--verb', '1']];

    return await new Promise(resolve => {
      let output = '';
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      proc.stdout?.on('data', d => {
        const s = d.toString().trim();
        output += s + '\n';
        console.log(`[vpn/${type}]`, s);
      });
      proc.stderr?.on('data', d => {
        const s = d.toString().trim();
        output += s + '\n';
        console.error(`[vpn/${type}]`, s);
      });

      proc.on('error', e => {
        // The tool wasn't found on PATH or couldn't be executed.
        vpnType = null;
        vpnConfigPath = null;
        vpnProc = null;
        resolve({ error: `'${cmd}' not found or could not start: ${e.message}. Make sure it is installed and the process has the required permissions.` });
      });

      if (type === 'WireGuard') {
        // wg-quick exits (code 0) once the interface is up; the kernel module keeps it alive.
        proc.on('exit', code => {
          vpnProc = null; // wg-quick is not a persistent daemon
          if (code === 0) {
            resolve({ ok: true });
          } else {
            vpnType = null;
            vpnConfigPath = null;
            // Include the last 6 lines of output for diagnostics.
            const tail = output.split('\n').slice(-6).join('\n');
            resolve({ error: `wg-quick exited with code ${code}.\n${tail}` });
          }
        });
        // Failsafe: if wg-quick doesn't exit within 15 s, give up.
        setTimeout(() => resolve({ error: 'wg-quick timed out after 15 s' }), 15000);
      } else {
        // OpenVPN runs as a long-lived process.
        vpnProc = proc;
        proc.on('exit', code => {
          vpnProc = null;
          // Only report exit as an error if it happens early (within 5 s) and we haven't resolved yet.
        });
        // Give OpenVPN 5 s to fail on its own; if still alive assume success.
        const timer = setTimeout(() => { if (vpnProc === proc) resolve({ ok: true }); }, 5000);
        proc.on('exit', code => {
          clearTimeout(timer);
          if (code !== null && code !== 0) {
            vpnType = null;
            vpnConfigPath = null;
            // Include last 8 lines for diagnostics.
            const tail = output.split('\n').slice(-8).join('\n');
            resolve({ error: `openvpn exited with code ${code}.\n${tail}` });
          }
        });
      }
    });
  } catch (e) {
    vpnType = null;
    vpnConfigPath = null;
    return { error: e.message };
  }
});

/**
 * Stop any currently-active VPN connection.
 */
ipcMain.handle('vpn-stop', async () => {
  await doStopVpn();
  return { ok: true };
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  startDaemon();
  // Give the daemon a short moment to bind its IPC port before we try to
  // connect.  800 ms is usually enough even on slow machines.
  setTimeout(connectToIpc, 800);
});

app.on('window-all-closed', async () => {
  // Clean up VPN and daemon before quitting.
  await doStopVpn();
  if (daemonProc) daemonProc.kill();
  app.quit();
});
