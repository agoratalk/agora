const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const net  = require('net');
const { spawn } = require('child_process');

// ── Config ─────────────────────────────────────────────────────────────────────
const IPC_PORT = 7779;
const DAEMON_BIN = process.platform === 'win32' ? 'agora.exe' : 'agora';
// Packaged: <resources>/bin/agora  |  Dev: ../daemon/target/release/agora
const DAEMON_PATH = path.join(process.resourcesPath || __dirname, 'bin', DAEMON_BIN);
const DAEMON_DEV_PATH = path.join(__dirname, '..', 'daemon', 'target', 'release', DAEMON_BIN);

let mainWindow;
let daemonProc  = null;
let ipcSocket   = null;

// ── VPN state ─────────────────────────────────────────────────────────────────
let vpnProc       = null;  // long-running process (openvpn); null for wg-quick
let vpnType       = null;  // 'WireGuard' | 'OpenVPN' | null
let vpnConfigPath = null;  // path to the written config file
let ipcBuffer = '';
let ipcReqId = 1;
const pendingRequests = new Map();

// ── Window ─────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 780,
    minHeight: 500,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
}

// ── Daemon management ──────────────────────────────────────────────────────────
function startDaemon() {
  const fs = require('fs');
  const binPath = fs.existsSync(DAEMON_PATH) ? DAEMON_PATH
               : fs.existsSync(DAEMON_DEV_PATH) ? DAEMON_DEV_PATH
               : DAEMON_BIN; // last resort: PATH

  try {
    daemonProc = spawn(binPath, ['--log', 'warn'], {
      detached: false,
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
function connectToIpc(retries = 10) {
  ipcSocket = new net.Socket();

  ipcSocket.on('data', chunk => {
    ipcBuffer += chunk.toString();
    const lines = ipcBuffer.split('\n');
    ipcBuffer = lines.pop(); // last element may be incomplete
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event) {
          // Push event → forward to renderer
          mainWindow?.webContents.send('daemon-event', msg);
        } else if (msg.id !== undefined) {
          // Response to a request
          const cb = pendingRequests.get(msg.id);
          if (cb) { pendingRequests.delete(msg.id); cb(msg); }
        }
      } catch (e) { console.error('IPC parse error:', e.message); }
    }
  });

  ipcSocket.on('error', () => {
    if (retries > 0) {
      setTimeout(() => connectToIpc(retries - 1), 600);
    } else {
      mainWindow?.webContents.send('daemon-event', { event: 'connection_failed', data: {} });
    }
  });

  ipcSocket.on('close', () => {
    ipcSocket = null;
    // Reconnect after a short delay
    setTimeout(() => connectToIpc(5), 2000);
  });

  ipcSocket.connect(IPC_PORT, '127.0.0.1');
}

function sendToIpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ipcSocket) { reject(new Error('not connected to daemon')); return; }
    const id = ipcReqId++;
    pendingRequests.set(id, resolve);
    const msg = JSON.stringify({ id, method, params }) + '\n';
    ipcSocket.write(msg);
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('timeout'));
      }
    }, 8000);
  });
}

// ── IPC handlers (renderer → main) ────────────────────────────────────────────
ipcMain.handle('daemon-request', async (_event, method, params) => {
  try {
    return await sendToIpc(method, params);
  } catch (e) {
    return { id: 0, error: e.message };
  }
});

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
        setTimeout(resolve, 6000);
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

ipcMain.handle('vpn-start', async (_event, type, configContent) => {
  // Tear down any running VPN first
  await doStopVpn();

  try {
    const userDataDir = app.getPath('userData');
    const ext     = type === 'WireGuard' ? '.conf' : '.ovpn';
    const cfgPath = path.join(userDataDir, `agora-vpn${ext}`);

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
        vpnType = null;
        vpnConfigPath = null;
        vpnProc = null;
        resolve({ error: `'${cmd}' not found or could not start: ${e.message}. Make sure it is installed and the process has the required permissions.` });
      });

      if (type === 'WireGuard') {
        // wg-quick exits (code 0) once the interface is up; the kernel module keeps it alive.
        proc.on('exit', code => {
          vpnProc = null; // wg-quick is not a daemon
          if (code === 0) {
            resolve({ ok: true });
          } else {
            vpnType = null;
            vpnConfigPath = null;
            const tail = output.split('\n').slice(-6).join('\n');
            resolve({ error: `wg-quick exited with code ${code}.\n${tail}` });
          }
        });
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

ipcMain.handle('vpn-stop', async () => {
  await doStopVpn();
  return { ok: true };
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  startDaemon();
  // Give daemon a moment to bind its IPC port
  setTimeout(connectToIpc, 800);
});

app.on('window-all-closed', async () => {
  await doStopVpn();
  if (daemonProc) daemonProc.kill();
  app.quit();
});
