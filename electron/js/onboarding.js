// ── Onboarding ────────────────────────────────────────────────────────────────
/**
 * First-run onboarding wizard — a multi-step overlay shown only once.
 *
 * Steps (0-indexed, OB_TOTAL_STEPS = 9):
 *   0  Language selection
 *   1  Connection type + optional VPN config
 *   2  "Connecting…" waiting screen (auto-advances when init() completes)
 *   3  Bootstrap server (optional — lets user enter a known peer to connect to)
 *   4  Username (optional)
 *   5  Avatar (optional)
 *   6  Channel discovery — channels found from peers, auto-skipped if none
 *   7  Community lists — peer blocklists/followlists, auto-skipped if none
 *   8  First post (optional)
 *
 * Completion is tracked via localStorage key 'agora_onboarded'.  Once set,
 * obIsFirstRun() returns false and the wizard is never shown again.
 *
 * obBlocklistSelections / obFollowlistSelections are checkbox state maps used
 * on step 7.  obChannelSelections is a Set of channel names to auto-follow.
 */
const OB_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'zh', label: '中文' },
  { code: 'ar', label: 'العربية' },
  { code: 'ru', label: 'Русский' },
  { code: 'ja', label: '日本語' },
  { code: 'hi', label: 'हिन्दी' },
];
const OB_TOTAL_STEPS = 9; // steps 0-8
let obCurrentStep = 0;
let obSelectedLang = 'en';
let obSelectedConnType = connType;
let obPendingAvatar = null;
let obBlocklistSelections = {};  // subKey → bool
let obFollowlistSelections = {}; // "pk::fl::listname" → bool
let obChannelSelections = new Set(); // channel names the user wants to join

function obIsFirstRun() {
  return !localStorage.getItem('agora_onboarded');
}

function obStart() {
  document.getElementById('onboarding-overlay').classList.remove('hidden');
  obBuildProgress();
  obBuildConnTypeGrid();
  obBuildLangGrid();
  obShowStep(0);
}

function obBuildConnTypeGrid() {
  const grid = document.getElementById('ob-conntype-grid');
  if (!grid) return;
  grid.innerHTML = '';
  CONN_TYPES.forEach(ct => {
    const btn = document.createElement('button');
    btn.className = 'ob-lang-btn' + (ct === obSelectedConnType ? ' selected' : '');
    btn.textContent = ct;
    btn.onclick = () => {
      obSelectedConnType = ct;
      document.querySelectorAll('#ob-conntype-grid .ob-lang-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      // Show/hide inline config section for VPN types
      const section = document.getElementById('ob-vpn-section');
      if (section) {
        const isVpn = VPN_TYPES.includes(ct);
        section.style.display = isVpn ? 'flex' : 'none';
        if (isVpn) {
          document.getElementById('ob-vpn-section-title').textContent = `${ct} config file`;
          // Pre-fill with any stored config
          const stored = getStoredVpnConfig(ct);
          document.getElementById('ob-vpn-paste').value = stored;
          const drop = document.getElementById('ob-vpn-drop');
          drop.classList.toggle('has-file', !!stored);
          document.getElementById('ob-vpn-drop-label').textContent =
            stored ? `${ct} config loaded — click to replace` : 'Drop .conf / .ovpn here or click to browse';
          document.getElementById('ob-vpn-status').className = 'vpn-status';
        }
      }
    };
    grid.appendChild(btn);
  });

  // Wire up the inline file picker for the onboarding section
  const obFileInput = document.getElementById('ob-vpn-file');
  const obDrop      = document.getElementById('ob-vpn-drop');
  const obPaste     = document.getElementById('ob-vpn-paste');

  obFileInput?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      obPaste.value = ev.target.result;
      obDrop.classList.add('has-file');
      document.getElementById('ob-vpn-drop-label').textContent = file.name;
    };
    reader.readAsText(file);
  });
  ['dragenter','dragover'].forEach(ev => obDrop?.addEventListener(ev, e => {
    e.preventDefault(); obDrop.classList.add('drag-over');
  }));
  ['dragleave','drop'].forEach(ev => obDrop?.addEventListener(ev, e => {
    e.preventDefault(); obDrop.classList.remove('drag-over');
  }));
  obDrop?.addEventListener('drop', e => {
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      obPaste.value = ev.target.result;
      obDrop.classList.add('has-file');
      document.getElementById('ob-vpn-drop-label').textContent = file.name;
    };
    reader.readAsText(file);
  });
}

async function obSaveConnType() {
  const type = obSelectedConnType;

  if (VPN_TYPES.includes(type)) {
    const config = document.getElementById('ob-vpn-paste')?.value.trim() || '';
    const status = document.getElementById('ob-vpn-status');

    const err = validateVpnConfig(type, config);
    if (err && config) {
      // Config was provided but is invalid
      if (status) { status.className = 'vpn-status err'; status.textContent = err; }
      return;
    }

    if (config) {
      // Valid config provided — try to start the VPN
      saveStoredVpnConfig(type, config);
      if (status) { status.className = 'vpn-status'; status.textContent = ''; }
      const resp = await window.agora?.vpnStart(type, config);
      if (resp?.error) {
        if (status) { status.className = 'vpn-status err'; status.textContent = resp.error; }
        // Non-blocking: let the user skip past the VPN error and continue
      } else if (status) {
        status.className = 'vpn-status ok';
        status.textContent = `${type} tunnel up`;
      }
    }
    // If no config provided, just set the type without starting — user can configure later
  }

  setConnType(type);
  obNext(2);
}

// Skip conn-type step: use raw, proceed to connecting
function obSaveConnTypeSkip() {
  setConnType('raw');
  obNext(2);
}

function obBuildProgress() {
  const el = document.getElementById('ob-progress');
  el.innerHTML = '';
  for (let i = 0; i < OB_TOTAL_STEPS; i++) {
    const pip = document.createElement('div');
    pip.className = 'ob-pip';
    pip.id = 'ob-pip-' + i;
    el.appendChild(pip);
  }
}

function obUpdateProgress(step) {
  for (let i = 0; i < OB_TOTAL_STEPS; i++) {
    const pip = document.getElementById('ob-pip-' + i);
    if (!pip) continue;
    pip.className = 'ob-pip' + (i < step ? ' done' : i === step ? ' cur' : '');
  }
}

function obBuildLangGrid() {
  const grid = document.getElementById('ob-lang-grid');
  grid.innerHTML = '';
  OB_LANGUAGES.forEach(lang => {
    const btn = document.createElement('button');
    btn.className = 'ob-lang-btn' + (lang.code === obSelectedLang ? ' selected' : '');
    btn.textContent = lang.label;
    btn.onclick = () => {
      obSelectedLang = lang.code;
      document.querySelectorAll('.ob-lang-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      applyTranslations(obSelectedLang);
    };
    grid.appendChild(btn);
  });
}

/**
 * Navigate to onboarding step n.  Shows/hides the step panels, updates the
 * progress pip row, and runs step-specific setup:
 *   Step 2: update the connection-status message to name the chosen transport.
 *   Step 6: populate the channel list from current posts; auto-skip if empty.
 *   Step 7: populate community blocklist/followlist picker; auto-skip if empty.
 */
function obShowStep(n) {
  obCurrentStep = n;
  document.querySelectorAll('.ob-step').forEach((el, i) => {
    el.classList.toggle('active', i === n);
  });
  obUpdateProgress(n);

  // Step 2: update the connecting-status text to reflect the chosen transport
  if (n === 2) {
    const span = document.querySelector('#ob-conn-status span');
    if (span) {
      if (connType === 'TOR') {
        span.textContent = 'Bootstrapping Tor… (embedded — no system Tor required)';
      } else if (connType === 'i2p') {
        span.textContent = 'Routing through I2P… (I2P router must be running with SOCKS5 on port 4447)';
      } else {
        span.textContent = 'Connecting to network…';
      }
    }
  }

  // Step 6: populate channels discovered from peers; auto-skip if none
  if (n === 6) {
    const channels = obFindChannels();
    if (channels.length === 0) { obShowStep(7); return; }
    const list = document.getElementById('ob-channel-list');
    list.innerHTML = '';
    obChannelSelections.clear();
    channels.forEach(ch => {
      const card = document.createElement('div');
      card.className = 'ob-blocklist-card';
      const info = document.createElement('div');
      info.innerHTML = `<div class="ob-blocklist-name">#${escHtml(ch.name)}</div><div class="ob-blocklist-count">${ch.postCount} post${ch.postCount !== 1 ? 's' : ''}</div>`;
      const chk = document.createElement('div');
      chk.className = 'ob-check';
      chk.onclick = () => {
        const sel = obChannelSelections.has(ch.name);
        if (sel) { obChannelSelections.delete(ch.name); chk.classList.remove('on'); chk.textContent = ''; }
        else { obChannelSelections.add(ch.name); chk.classList.add('on'); chk.textContent = '✓'; }
      };
      card.appendChild(info);
      card.appendChild(chk);
      list.appendChild(card);
    });
  }

  // Step 7: populate community lists (blocklists + followlists); auto-skip if none
  if (n === 7) {
    const bls = obFindPeerBlocklists();
    const fls = obFindPeerFollowlists();
    if (bls.length === 0 && fls.length === 0) { obShowStep(8); return; }
    const list = document.getElementById('ob-community-list');
    list.innerHTML = '';
    obBlocklistSelections = {};
    obFollowlistSelections = {};

    if (bls.length > 0) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'font-family:var(--mono);font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;padding:4px 0 2px';
      hdr.textContent = 'Block lists';
      list.appendChild(hdr);
      bls.forEach(item => {
        const selKey = subKey(item.pubkey, item.listName);
        obBlocklistSelections[selKey] = false;
        const card = document.createElement('div');
        card.className = 'ob-blocklist-card';
        const info = document.createElement('div');
        info.innerHTML = `<div class="ob-blocklist-name">${escHtml(item.name)}</div><div class="ob-blocklist-count">${item.count} entr${item.count === 1 ? 'y' : 'ies'}</div>`;
        const chk = document.createElement('div');
        chk.className = 'ob-check';
        chk.onclick = () => {
          obBlocklistSelections[selKey] = !obBlocklistSelections[selKey];
          chk.classList.toggle('on', obBlocklistSelections[selKey]);
          chk.textContent = obBlocklistSelections[selKey] ? '✓' : '';
        };
        card.appendChild(info);
        card.appendChild(chk);
        list.appendChild(card);
      });
    }

    if (fls.length > 0) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'font-family:var(--mono);font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;padding:8px 0 2px';
      hdr.textContent = 'Follow lists';
      list.appendChild(hdr);
      fls.forEach(item => {
        const selKey = item.pubkey + '::fl::' + item.listName;
        obFollowlistSelections[selKey] = false;
        const card = document.createElement('div');
        card.className = 'ob-blocklist-card';
        const info = document.createElement('div');
        info.innerHTML = `<div class="ob-blocklist-name">${escHtml(item.name)}</div><div class="ob-blocklist-count">${item.count} user${item.count !== 1 ? 's' : ''}</div>`;
        const chk = document.createElement('div');
        chk.className = 'ob-check';
        chk.onclick = () => {
          obFollowlistSelections[selKey] = !obFollowlistSelections[selKey];
          chk.classList.toggle('on', obFollowlistSelections[selKey]);
          chk.textContent = obFollowlistSelections[selKey] ? '✓' : '';
        };
        card.appendChild(info);
        card.appendChild(chk);
        list.appendChild(card);
      });
    }
  }
}

function obNext(n) { obShowStep(n); }

/**
 * Scan in-memory posts for blocklist broadcasts published by peers.
 * Used in onboarding step 7 to show community blocklists the user can subscribe to.
 * Only the most-recent post per (pubkey, listName) pair is returned, and our
 * own posts are excluded.
 */
function obFindPeerBlocklists() {
  const seen = {}; // key: "pubkey::listname"
  posts.forEach(p => {
    const bl = parseBlocklistPost(p.content);
    if (!bl || !bl.pubkeys?.length) return;
    if (p.sender_pubkey === myIdentity?.pubkey) return;
    const blName = bl.list_name || DEFAULT_LIST_NAME;
    const key = subKey(p.sender_pubkey, blName);
    if (!seen[key] || new Date(p.timestamp) > new Date(seen[key].timestamp)) {
      const author = p.sender_username || p.sender_fingerprint || p.sender_pubkey.slice(0, 12);
      seen[key] = {
        pubkey: p.sender_pubkey,
        listName: blName,
        name: blName === DEFAULT_LIST_NAME ? author : `${author} — ${blName}`,
        count: bl.pubkeys.length,
        pubkeys: bl.pubkeys,
        timestamp: p.timestamp,
      };
    }
  });
  return Object.values(seen);
}

// Scan in-memory posts for channel posts.  Returns an array of { name, postCount }
// sorted by activity (most posts first) for the onboarding channel step.
function obFindChannels() {
  const counts = {};
  posts.forEach(p => {
    const ch = parseChannelPost(p.content);
    if (!ch || isChannelBlocked(ch.channel)) return;
    counts[ch.channel] = (counts[ch.channel] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([name, postCount]) => ({ name, postCount }))
    .sort((a, b) => b.postCount - a.postCount);
}

// Scan in-memory posts for follow list broadcasts published by peers.
// Same logic as obFindPeerBlocklists() but for follow lists.
function obFindPeerFollowlists() {
  const seen = {};
  posts.forEach(p => {
    const fl = parseFollowlistPost(p.content);
    if (!fl || !fl.pubkeys?.length) return;
    if (p.sender_pubkey === myIdentity?.pubkey) return;
    const listName = fl.list_name || DEFAULT_FOLLOW_LIST;
    const key = p.sender_pubkey + '::' + listName;
    if (!seen[key] || new Date(p.timestamp) > new Date(seen[key].timestamp)) {
      const author = p.sender_username || p.sender_fingerprint || p.sender_pubkey.slice(0, 12);
      seen[key] = {
        pubkey: p.sender_pubkey,
        listName,
        name: listName === DEFAULT_FOLLOW_LIST ? author : `${author} — ${listName}`,
        count: fl.pubkeys.length,
        pubkeys: fl.pubkeys,
        timestamp: p.timestamp,
      };
    }
  });
  return Object.values(seen);
}

// Advance from the channel selection step.  The actual following of selected
// channels happens in obFinish() via setActiveChannel(), not here.
function obJoinSelectedChannels() {
  obShowStep(7);
}

async function obBootstrapNext(skip = false) {
  if (!skip) {
    const addr = document.getElementById('ob-bootstrap-input').value.trim();
    if (addr) {
      const resp = await window.agora?.request('connect', { addr });
      if (resp?.error) { toast('Connect failed: ' + resp.error, 'error'); }
      else { toast('Dialling ' + addr + '…', 'success'); }
    }
  }
  obShowStep(4); // → username
}

async function obSaveUsername() {
  const uname = document.getElementById('ob-username-input').value.trim();
  if (uname) {
    const resp = await window.agora?.request('set_username', { username: uname });
    if (resp?.error) { toast('Username error: ' + resp.error, 'error'); return; }
    if (myIdentity) myIdentity.username = uname;
    document.getElementById('my-name').textContent = uname;
    document.getElementById('ob-avatar-initial').textContent = uname.charAt(0).toUpperCase();
  }
  obShowStep(5); // → avatar
}

function obClearAvatar() {
  obPendingAvatar = null;
  document.getElementById('ob-avatar-pick').innerHTML = '<span id="ob-avatar-initial">' +
    escHtml((myIdentity?.username || '?').charAt(0).toUpperCase()) + '</span>';
  document.getElementById('ob-avatar-clear-btn').style.display = 'none';
}

async function obSaveAvatar() {
  if (obPendingAvatar) {
    const resp = await window.agora?.request('set_avatar', { data: obPendingAvatar });
    if (resp?.error) { toast('Avatar error: ' + resp.error, 'error'); return; }
    if (myIdentity) myIdentity.avatar = obPendingAvatar;
    renderIdentityAvatar();
    obPendingAvatar = null;
  }
  obShowStep(6); // → blocklists
}

/**
 * Called when the user clicks "Apply & Next" on the community lists step.
 * Imports all selected blocklists and follow lists, subscribes the user to
 * auto-update when those peers re-broadcast, then advances to the first-post step.
 */
function obImportSelected() {
  // Import selected blocklists into "Imported from <author>" lists
  obFindPeerBlocklists().forEach(item => {
    const selKey = subKey(item.pubkey, item.listName);
    if (obBlocklistSelections[selKey]) {
      const importId = getOrCreateOwnedList('Imported from ' + item.name);
      importBlocklistPubkeys(item.pubkeys, importId, true);
      subscribedToBlocklists.add(selKey);
    }
  });
  saveBlocklists();
  saveSubscriptions();
  // Import selected followlists
  obFindPeerFollowlists().forEach(item => {
    const selKey = item.pubkey + '::fl::' + item.listName;
    if (obFollowlistSelections[selKey]) {
      const listId = getOrCreateFollowList('Imported from ' + item.name);
      for (const pk of item.pubkeys) {
        if (pk !== myIdentity?.pubkey) followlists[listId].pubkeys.add(pk);
      }
    }
  });
  saveFollowlists();
  updateFollowingIndicator();
  obShowStep(8); // → first post
}

async function obPublishFirstPost() {
  const content = document.getElementById('ob-first-post').value.trim();
  if (content) {
    const resp = await window.agora?.request('broadcast', { content });
    if (resp?.error) { toast('Post failed: ' + resp.error, 'error'); return; }
    await refreshPosts();
  }
  obFinish();
}

/**
 * Finalise onboarding:
 *   1. Persist the 'agora_onboarded' flag so the wizard never shows again.
 *   2. Hide the overlay.
 *   3. If any channels were selected, navigate to the feed and open the first
 *      channel after a short delay (to let the overlay fade out).
 */
function obFinish() {
  try { localStorage.setItem('agora_onboarded', '1'); } catch {}
  document.getElementById('onboarding-overlay').classList.add('hidden');
  // Navigate to first joined channel (or just the feed if any channel was selected)
  if (obChannelSelections.size > 0) {
    const firstCh = [...obChannelSelections][0];
    switchTab('feed');
    setTimeout(() => setActiveChannel(firstCh), 80);
  }
}

// Wire up the onboarding avatar file picker.  Same crop-to-square-128px logic
// as the main avatar picker but operating on obPendingAvatar state instead of
// pendingAvatarDataUrl.
function obInitAvatarPicker() {
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
  document.getElementById('ob-avatar-file')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ALLOWED.includes(file.type)) { toast('Avatar must be JPEG, PNG, or WebP', 'error'); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onerror = () => toast('Could not load image', 'error');
      img.onload = () => {
        const SIZE = 128;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
        const outType = file.type === 'image/png' ? 'image/png' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
        obPendingAvatar = canvas.toDataURL(outType, 0.75);
        document.getElementById('ob-avatar-pick').innerHTML = `<img src="${escHtml(obPendingAvatar)}" alt=""/>`;
        document.getElementById('ob-avatar-clear-btn').style.display = '';
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
/**
 * DOMContentLoaded handler — wires up all event listeners and starts the app.
 *
 * Sets up:
 *   - Auto-resize for all textareas (msg, post, comment inputs).
 *   - Embed URL auto-detection on the post composer input.
 *   - Keyboard shortcuts:
 *       Ctrl/Cmd+Enter — send message / submit post / submit comment
 *       Enter          — save username / dial peer
 *       Escape         — cancel modals (username input)
 *   - File input listeners for post images, DM images, comment images, and
 *     the profile avatar picker.
 *   - Outside-click handler to close the notification panel.
 *   - Initialises the VPN modal file picker and drag-and-drop.
 *   - Keyboard shortcuts for onboarding inputs.
 *
 * After all wiring, calls init() which loads state from the daemon, then
 * starts the onboarding wizard if this is the first run.
 */
document.addEventListener('DOMContentLoaded', async () => {
  // Seed the post-limit button label from the persisted preference
  const limitLabel = document.getElementById('post-limit-label');
  if (limitLabel) limitLabel.textContent = postLimit;

  // Auto-resize textareas
  ['msg-input', 'post-input'].forEach(id => {
    const ta = document.getElementById(id);
    if (!ta) return;
    ta.addEventListener('input', () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,120)+'px'; });
  });
  // Embed URL auto-detection for post composer
  document.getElementById('post-input')?.addEventListener('input', onPostInputChange);
  document.getElementById('msg-input')?.addEventListener('keydown', e => {
    if ((e.ctrlKey||e.metaKey) && e.key==='Enter') { e.preventDefault(); sendMessage(); }
  });
  document.getElementById('post-input')?.addEventListener('keydown', e => {
    if ((e.ctrlKey||e.metaKey) && e.key==='Enter') { e.preventDefault(); submitPost(); }
  });
  document.getElementById('comment-input')?.addEventListener('keydown', e => {
    if ((e.ctrlKey||e.metaKey) && e.key==='Enter') { e.preventDefault(); submitComment(); }
  });
  document.getElementById('username-input')?.addEventListener('keydown', e => {
    if (e.key==='Enter') saveUsername();
    if (e.key==='Escape') closeModal('username-modal');
  });
  document.getElementById('connect-input')?.addEventListener('keydown', e => {
    if (e.key==='Enter') dialPeer();
  });
  // Post image file picker
  document.getElementById('post-image-file')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      pendingPostImage = await processImageFile(file);
      document.getElementById('post-attach-thumb').src = pendingPostImage;
      document.getElementById('post-attach-preview').style.display = 'inline-flex';
      document.getElementById('post-attach-btn').classList.add('has-image');
    } catch (err) { toast(err.message, 'error'); }
  });

  // Comment image file picker
  document.getElementById('comment-image-file')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      pendingCommentImage = await processImageFile(file);
      document.getElementById('comment-attach-thumb').src = pendingCommentImage;
      document.getElementById('comment-attach-preview').style.display = 'inline-flex';
      document.getElementById('comment-attach-btn').classList.add('has-image');
    } catch (err) { toast(err.message, 'error'); }
  });

  // DM image file picker
  document.getElementById('dm-image-file')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      pendingDmImage = await processImageFile(file);
      document.getElementById('dm-attach-thumb').src = pendingDmImage;
      document.getElementById('dm-attach-preview').style.display = 'inline-flex';
      document.getElementById('dm-attach-btn').classList.add('has-image');
    } catch (err) { toast(err.message, 'error'); }
  });

  // Avatar file picker: validate type, resize to 128×128, re-encode as JPEG/PNG/WebP
  const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  document.getElementById('avatar-file')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so same file can be re-picked
    if (!file) return;
    if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
      toast('Avatar must be a JPEG, PNG, or WebP image', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onerror = () => toast('Could not load image', 'error');
      img.onload = () => {
        const SIZE = 128;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        // Cover-fit: crop to square from center
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
        // Re-encode as the same type (WebP keeps transparency; JPEG is smallest)
        const outType = file.type === 'image/png' ? 'image/png'
                      : file.type === 'image/webp' ? 'image/webp'
                      : 'image/jpeg';
        pendingAvatarDataUrl = canvas.toDataURL(outType, 0.75);
        document.getElementById('avatar-preview').innerHTML = `<img src="${escHtml(pendingAvatarDataUrl)}" alt=""/>`;
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
  // Close notif panel on outside click
  document.addEventListener('click', e => {
    if (notifPanelOpen && !document.getElementById('notif-panel').contains(e.target) && e.target.id !== 'notif-btn') {
      notifPanelOpen = false;
      document.getElementById('notif-panel').classList.remove('open');
    }
  });
  obInitAvatarPicker();
  initVpnModal();
  // Keyboard shortcuts inside onboarding steps
  document.getElementById('ob-bootstrap-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') obBootstrapNext(); });
  document.getElementById('custom-limit-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') applyCustomLimit(); });
  document.getElementById('ob-username-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') obSaveUsername(); });
  document.getElementById('ob-first-post')?.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') obPublishFirstPost(); });
  await init();
  if (obIsFirstRun()) obStart();
});

// ── Demo data (when running outside Electron) ─────────────────────────────────
/**
 * Populate synthetic state so the UI is functional for screenshot/dev purposes
 * when `window.agora` is not available (plain browser, no daemon).
 *
 * loadDemoData() is called by init() when the IPC bridge is absent.  It
 * populates myIdentity, peers, posts, and messages with hardcoded values,
 * then renders all the same components that a real startup would.
 */
function loadDemoData() {
  myIdentity = { username: 'demo_user', fingerprint: 'AB:CD:EF:12:34:56:78:90', pubkey: 'demokey123', account_name: 'default', avatar: null };
  document.getElementById('my-name').textContent = 'demo_user';
  document.getElementById('my-fp').textContent = 'demokey123…';
  document.getElementById('my-account').textContent = 'default';
  peers = [
    { pubkey:'p1', fingerprint:'AA:BB:CC:DD:EE:FF:00:11', username:'alice', addr:'10.0.0.2:7777', discovery:'bootstrap' },
    { pubkey:'p2', fingerprint:'11:22:33:44:55:66:77:88', username:null, addr:'10.0.0.3:7777', discovery:'mdns' },
  ];
  posts = [
    { post_id:'abc12345-0000-0000-0000-000000000001', sender_pubkey:'p1', sender_fingerprint:'AA:BB:CC:DD:EE:FF:00:11', sender_username:'alice', content:'Hello p2p network! This post is propagated for 24 hours by every node that receives it.', timestamp:new Date(Date.now()-120000).toISOString(), like_count:3, is_own:false },
    { post_id:'def67890-0000-0000-0000-000000000002', sender_pubkey:'demokey123', sender_fingerprint:'AB:CD:EF:12:34:56:78:90', sender_username:'demo_user', content:'My first public post on this decentralised network!', timestamp:new Date(Date.now()-60000).toISOString(), like_count:1, is_own:true },
  ];
  messages = [
    { kind:'dm', own:false, sender_pubkey:'p1', sender_fingerprint:'AA:BB:CC:DD:EE:FF:00:11', sender_username:'alice', content:'Hey! Are you on the bootstrap net?', timestamp:new Date(Date.now()-60000).toISOString() },
  ];
  renderIdentityAvatar();
  renderPeerList();
  renderFeed();
  setConnected(false);
  toast('Demo mode — not connected to daemon', 'error');
}
