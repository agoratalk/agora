// ── Helpers ────────────────────────────────────────────────────────────────────
/**
 * Miscellaneous UI helpers.
 *
 * Connection types supported by the daemon:
 *   raw      — plain TCP (default, no VPN/anonymiser)
 *   WireGuard — kernel WireGuard tunnel (requires wg-quick + config file)
 *   OpenVPN  — OpenVPN tunnel (requires openvpn + .ovpn config)
 *   TOR      — embedded Tor via arti (no system Tor required)
 *   i2p      — I2P SOCKS5 proxy (requires local I2P router on port 4447)
 *   nym      — Nym mixnet (experimental)
 *   QUIC     — QUIC transport (experimental)
 *
 * The active connection type is persisted to localStorage so the daemon is
 * configured to use the correct transport on the next startup.
 */
const CONN_TYPES = ['raw', 'WireGuard', 'OpenVPN', 'TOR', 'i2p', 'nym', 'QUIC'];
let connType = localStorage.getItem('agora_conn_type') || 'raw';

function setConnected(ok) {
  document.getElementById('conn-dot').className = 'conn-dot' + (ok ? ' connected' : '');
  document.getElementById('conn-label').textContent = ok ? 'connected - ' + connType : 'disconnected';
}

function toggleConnMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('conn-menu');
  const opening = menu.style.display === 'none';
  menu.style.display = opening ? 'block' : 'none';
  if (opening) fetchAndShowIps();
}

/**
 * Fetch and display the public/exit IP in the connection menu.
 *
 * The daemon's `get_public_ip` RPC makes an outgoing HTTP request through its
 * own connection stack (the same stack used for peer connections).  This means:
 *   - Raw/WireGuard/OpenVPN → returns the host's real or VPN exit IP.
 *   - TOR → returns the Tor exit-node IP (anonymised), so the label says
 *            "exit node" rather than "public ip" to avoid user confusion.
 *   - I2P → returns the I2P outproxy IP.
 *
 * Called when the connection menu first opens and after a Tor 'ready' event.
 */
async function fetchAndShowIps() {
  const pubEl  = document.getElementById('conn-ip-public');
  const lbl    = document.getElementById('conn-ip-label');
  pubEl.textContent = '…';

  // Determine current connection type so we can label the IP correctly.
  let connType = 'raw';
  try {
    const ct = await window.agora?.request('get_conn_type', {});
    connType = ct?.type ?? 'raw';
  } catch {}

  if (lbl) {
    lbl.textContent = connType === 'TOR' ? 'exit node' : 'public ip';
  }

  // Ask the daemon to fetch the public IP through its own connection stack.
  // When Tor is active the daemon makes the request through the Tor circuit,
  // so the returned address is the exit-node IP, not the real IP.
  try {
    const res = await window.agora?.request('get_public_ip', {});
    pubEl.textContent = res?.ip ?? 'unknown';
  } catch {
    pubEl.textContent = 'unknown';
  }
}

// Types that need a config file before they can be used.
// For these types, clicking them in the connection menu opens the VPN modal
// rather than applying the type immediately.
const VPN_TYPES = ['WireGuard', 'OpenVPN'];

// ── VPN helpers ────────────────────────────────────────────────────────────────
/**
 * VPN config persistence.  Each VPN type (WireGuard, OpenVPN) has its config
 * text stored in localStorage under 'agora_vpn_config_<type>' so the tunnel
 * can be auto-reconnected on startup without the user re-uploading their config.
 *
 * validateVpnConfig() does a lightweight structural check (looks for required
 * sections/directives) to catch obvious mistakes before sending to the daemon.
 *
 * applyConnType() is the single point that changes both the UI state (button
 * highlights, connection label) and pushes the new type to the daemon.
 * clickConnType() is the public entry point for UI-triggered type changes.
 */
function getStoredVpnConfig(type) {
  try { return localStorage.getItem(`agora_vpn_config_${type}`) || ''; } catch { return ''; }
}
function saveStoredVpnConfig(type, config) {
  try { if (config) localStorage.setItem(`agora_vpn_config_${type}`, config); } catch {}
}

function validateVpnConfig(type, text) {
  const t = text.trim();
  if (!t) return 'Config is empty.';
  if (type === 'WireGuard') {
    if (!t.includes('[Interface]')) return 'Missing [Interface] section — is this a valid WireGuard config?';
    if (!t.includes('[Peer]'))      return 'Missing [Peer] section — is this a valid WireGuard config?';
    if (!t.includes('PrivateKey')) return 'Missing PrivateKey — is this a valid WireGuard config?';
  } else if (type === 'OpenVPN') {
    if (!t.includes('remote') && !t.includes('client'))
      return 'Does not look like an OpenVPN config (no "remote" or "client" directive found).';
  }
  return null; // valid
}

/**
 * Apply a new connection type — update UI state and inform the daemon.
 *
 * If the user is switching away from a VPN type (WireGuard/OpenVPN) to any
 * other type, the running tunnel is torn down via `vpnStop()`.  This prevents
 * the VPN from staying active in the background when the user intended to stop it.
 *
 * `save = false` is used during onboarding where we want the type active for
 * the session but may not want to persist it until the user explicitly confirms.
 */
function applyConnType(type, save = true) {
  const prev = connType;
  connType = type;
  if (save) { try { localStorage.setItem('agora_conn_type', type); } catch {} }

  // Stop any running VPN if the user is switching away from a VPN type
  if (VPN_TYPES.includes(prev) && type !== prev) {
    window.agora?.vpnStop();
  }

  window.agora?.request('set_conn_type', { type });
  document.getElementById('conn-menu').style.display = 'none';
  document.querySelectorAll('.conn-menu-item').forEach(el => {
    el.classList.toggle('active', el.textContent === type);
  });
  document.querySelectorAll('.settings-conn-btn').forEach(el => {
    el.classList.toggle('active', el.dataset.ct === type);
  });
  const label = document.getElementById('conn-label');
  if (label.textContent !== 'disconnected' && label.textContent !== 'connecting…') {
    label.textContent = 'connected - ' + connType;
  }
}

// Public entry point used by titlebar dropdown, settings panel, and any other caller.
// For WireGuard/OpenVPN it opens the config modal; for others it applies immediately.
function clickConnType(type) {
  if (VPN_TYPES.includes(type)) {
    openVpnModal(type);
  } else {
    applyConnType(type);
  }
}

// Keep old name working (called from obSaveConnType which already resolved config)
function setConnType(type, save = true) { applyConnType(type, save); }

// ── VPN config modal ───────────────────────────────────────────────────────────
let vpnModalTargetType = null;

function openVpnModal(type) {
  vpnModalTargetType = type;
  document.getElementById('vpn-modal-title').textContent = `${type} Configuration`;
  const isWg = type === 'WireGuard';
  document.getElementById('vpn-modal-hint').textContent =
    isWg ? 'Provide your WireGuard .conf file. wg-quick must be installed and the process needs permission to modify network interfaces.'
          : 'Provide your OpenVPN .ovpn file. openvpn must be installed and the process needs permission to modify network interfaces.';
  document.getElementById('vpn-file-input').accept = isWg ? '.conf,.txt' : '.ovpn,.conf,.txt';

  // Pre-fill with any previously saved config for this type
  const stored = getStoredVpnConfig(type);
  document.getElementById('vpn-paste').value = stored;
  const drop = document.getElementById('vpn-drop-zone');
  drop.classList.toggle('has-file', !!stored);
  document.getElementById('vpn-drop-label').textContent =
    stored ? `${type} config loaded — click to replace` : 'Drop config file here or click to browse';

  document.getElementById('vpn-status').className = 'vpn-status';
  document.getElementById('vpn-status').textContent = '';
  document.getElementById('vpn-modal').classList.add('open');
}

function closeVpnModal() {
  document.getElementById('vpn-modal').classList.remove('open');
  vpnModalTargetType = null;
}

async function applyVpnModal() {
  const type   = vpnModalTargetType;
  const config = document.getElementById('vpn-paste').value.trim();
  const status = document.getElementById('vpn-status');
  const btn    = document.getElementById('vpn-apply-btn');

  const err = validateVpnConfig(type, config);
  if (err) { status.className = 'vpn-status err'; status.textContent = err; return; }

  btn.textContent = 'Connecting…';
  btn.disabled = true;
  status.className = 'vpn-status';
  status.textContent = '';

  saveStoredVpnConfig(type, config);
  const resp = await window.agora?.vpnStart(type, config);

  btn.textContent = 'Connect';
  btn.disabled = false;

  if (resp?.error) {
    status.className = 'vpn-status err';
    status.textContent = resp.error;
    return;
  }

  status.className = 'vpn-status ok';
  status.textContent = `${type} tunnel up`;
  applyConnType(type);
  setTimeout(closeVpnModal, 800);
}

/**
 * Wire up the VPN config modal's file picker and drag-and-drop zones.
 * Called once from DOMContentLoaded.  Handles both the file <input> change event
 * and HTML5 drag-and-drop onto the drop zone area.
 *
 * In both cases the file's text content is read with FileReader and placed
 * in the paste textarea so the user can review/edit it before clicking Connect.
 */
function initVpnModal() {
  const fileInput = document.getElementById('vpn-file-input');
  const drop      = document.getElementById('vpn-drop-zone');
  const paste     = document.getElementById('vpn-paste');

  fileInput?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      paste.value = ev.target.result;
      drop.classList.add('has-file');
      document.getElementById('vpn-drop-label').textContent = file.name;
    };
    reader.readAsText(file);
  });

  ['dragenter','dragover'].forEach(ev => drop?.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add('drag-over');
  }));
  ['dragleave','drop'].forEach(ev => drop?.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove('drag-over');
  }));
  drop?.addEventListener('drop', e => {
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      paste.value = ev.target.result;
      drop.classList.add('has-file');
      document.getElementById('vpn-drop-label').textContent = file.name;
    };
    reader.readAsText(file);
  });
}

// ── Settings panel ─────────────────────────────────────────────────────────────
/**
 * The settings panel is a fly-out overlay in the sidebar footer.  It contains:
 *   - Connection type grid (same types as the titlebar dropdown)
 *   - Language selector (same languages as onboarding step 0)
 *
 * The grid/select are built lazily on first open to avoid cluttering startup.
 * The panel is mutually exclusive with the notification panel — opening one
 * closes the other.
 */
let settingsPanelOpen = false;

function buildSettingsPanel() {
  // Connection type grid
  const grid = document.getElementById('settings-conn-grid');
  if (grid && !grid.childElementCount) {
    CONN_TYPES.forEach(ct => {
      const btn = document.createElement('button');
      btn.className = 'settings-conn-btn' + (ct === connType ? ' active' : '');
      btn.dataset.ct = ct;
      btn.textContent = ct;
      btn.onclick = () => { closeSettingsPanel(); clickConnType(ct); };
      grid.appendChild(btn);
    });
  }
  // Language select
  const sel = document.getElementById('settings-lang-select');
  if (sel && !sel.childElementCount) {
    const savedLang = localStorage.getItem('agora_lang') || 'en';
    OB_LANGUAGES.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.label;
      opt.selected = l.code === savedLang;
      sel.appendChild(opt);
    });
  }
}

function settingsSaveLang(code) {
  applyTranslations(code);
}

function toggleSettingsPanel(e) {
  e.stopPropagation();
  settingsPanelOpen = !settingsPanelOpen;
  buildSettingsPanel();
  document.getElementById('settings-panel').classList.toggle('open', settingsPanelOpen);
  // Close notif panel if open
  if (settingsPanelOpen && notifPanelOpen) {
    notifPanelOpen = false;
    document.getElementById('notif-panel').classList.remove('open');
  }
}

function closeSettingsPanel() {
  settingsPanelOpen = false;
  document.getElementById('settings-panel').classList.remove('open');
}

// ── Peer / chat action menus ────────────────────────────────────────────────────
/**
 * The peer list and chat header each have a "⋯" action menu (block, follow, …).
 * _openPeerMenu tracks the currently open dropdown so that clicking a different
 * peer's menu (or clicking anywhere outside) closes the previous one.
 *
 * The global document click listener (defined below) handles outside-click
 * dismissal for peer menus, the conn menu, the settings panel, and the channel
 * dropdown all in one place.
 */
let _openPeerMenu = null;

function openPeerMenu(btn) {
  const dropdown = btn.nextElementSibling;
  if (_openPeerMenu && _openPeerMenu !== dropdown) _openPeerMenu.classList.remove('open');
  dropdown.classList.toggle('open');
  _openPeerMenu = dropdown.classList.contains('open') ? dropdown : null;
}

function closePeerMenu(el) {
  const dropdown = el.closest('.peer-menu-dropdown');
  if (dropdown) dropdown.classList.remove('open');
  if (_openPeerMenu === dropdown) _openPeerMenu = null;
}

function closeChatMenu() {
  const dropdown = document.getElementById('chat-block-btn')?.closest('.peer-menu-dropdown');
  if (dropdown) dropdown.classList.remove('open');
  if (_openPeerMenu === dropdown) _openPeerMenu = null;
}

document.addEventListener('click', e => {
  const menu = document.getElementById('conn-menu');
  if (menu) menu.style.display = 'none';
  // Close open peer/chat action menus when clicking outside
  if (_openPeerMenu && !_openPeerMenu.contains(e.target) && !_openPeerMenu.previousElementSibling?.contains(e.target)) {
    _openPeerMenu.classList.remove('open');
    _openPeerMenu = null;
  }
  if (settingsPanelOpen &&
      !document.getElementById('settings-panel').contains(e.target) &&
      e.target.id !== 'settings-btn') {
    closeSettingsPanel();
  }
  // Close channel menu when clicking outside
  const chDd = document.getElementById('ch-dropdown');
  const chMb = document.getElementById('ch-menu-btn');
  if (chDd && chDd.classList.contains('open') && !chDd.contains(e.target) && e.target !== chMb) {
    chDd.classList.remove('open');
  }
});

// Best-effort display name from an event data object — prefers username, then
// fingerprint, then the first 8 chars of the pubkey.
function displayName(d) { return d.sender_username || d.sender_fingerprint || d.sender_pubkey?.slice(0,8) || '?'; }

// Human-readable timestamp: HH:MM for today, "Mon DD HH:MM" for older dates.
function formatTime(ts) {
  try {
    const d = new Date(ts);
    const now = new Date();
    if (now - d < 86400000) return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    return d.toLocaleDateString([], {month:'short', day:'numeric'}) + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  } catch { return ''; }
}

// Truncate string to n characters with an ellipsis if necessary.
function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

/**
 * HTML-escape a value for safe insertion into innerHTML.
 * Handles: & < > "
 * Note: single-quotes are not escaped because we always use double-quoted
 * HTML attributes.  null/undefined are converted to empty string.
 */
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let toastTimer;
// Show a transient status toast for 3.5 seconds.
// `type` maps to a CSS class: 'info' | 'success' | 'error' | 'like'
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3500);
}

// ── Post limit dropdown ───────────────────────────────────────────────────────

function togglePostLimitDropdown(event) {
  event.stopPropagation();
  const dd = document.getElementById('post-limit-dropdown');
  if (!dd) return;
  const isOpen = dd.classList.contains('open');
  dd.classList.toggle('open', !isOpen);
  if (!isOpen) {
    // Mark the currently active option
    dd.querySelectorAll('.post-limit-item[data-val]').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.val) === postLimit);
    });
    // Close when clicking anywhere outside
    setTimeout(() => {
      document.addEventListener('click', function _close() {
        dd.classList.remove('open');
        document.removeEventListener('click', _close);
      }, { once: true });
    }, 0);
  }
}

// Apply a numeric post limit: persist, sync to daemon, refresh feed.
async function selectPostLimit(n) {
  document.getElementById('post-limit-dropdown')?.classList.remove('open');
  postLimit = n;
  localStorage.setItem('agora_post_limit', String(n));
  document.getElementById('post-limit-label').textContent = n;
  if (window.agora?.request) {
    await window.agora.request('set_post_limit', { limit: n });
  }
  await refreshPosts();
  toast(`Post limit set to ${n}`, 'success');
}

function openCustomLimitModal() {
  document.getElementById('post-limit-dropdown')?.classList.remove('open');
  const input = document.getElementById('custom-limit-input');
  if (input) input.value = postLimit;
  openModal('custom-limit-modal');
  setTimeout(() => input?.focus(), 80);
}

async function applyCustomLimit() {
  const input = document.getElementById('custom-limit-input');
  const raw = input?.value.trim();
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000 || raw !== String(n)) {
    toast('Enter a whole number between 0 and 1,000,000', 'error');
    return;
  }
  closeModal('custom-limit-modal');
  await selectPostLimit(n);
}
