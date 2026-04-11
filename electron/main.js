const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

// ── Config ─────────────────────────────────────────────────────────────────────
const IPC_PORT = 7779;
const DAEMON_BIN = process.platform === 'win32' ? 'agora.exe' : 'agora';
// Packaged: <resources>/bin/agora  |  Dev: ../daemon/target/release/agora
const DAEMON_PATH = path.join(process.resourcesPath || __dirname, 'bin', DAEMON_BIN);
const DAEMON_DEV_PATH = path.join(__dirname, '..', 'daemon', 'target', 'release', DAEMON_BIN);

let mainWindow;
let daemonProc = null;
let ipcSocket = null;
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

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  startDaemon();
  // Give daemon a moment to bind its IPC port
  setTimeout(connectToIpc, 800);
});

app.on('window-all-closed', () => {
  if (daemonProc) daemonProc.kill();
  app.quit();
});
