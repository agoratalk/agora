// ── Group chats ────────────────────────────────────────────────────────────────
/**
 * Group chats are implemented entirely client-side using DM fan-out.  There is
 * no server or daemon support for groups — the Rust code only provides the
 * encrypted DM transport.
 *
 * ## Protocol
 * Two DM message types carry group traffic, distinguished by magic prefix:
 *
 *   GROUP_MSG_MAGIC — a chat message:
 *     "agora:group:msg:v1:" + JSON({ gid, mid, image? }) + "\n" + text
 *
 *   GROUP_SYS_MAGIC — a system/control message:
 *     "agora:group:sys:v1:" + JSON({ op, gid, … })
 *
 * System ops: 'create', 'invite', 'kick', 'leave', 'member_added',
 *             'promote', 'demote'
 *
 * ## Fan-out
 * Every message is sent individually as a DM to each group member except the
 * sender.  This means group messages are as private as normal DMs — E2E
 * encrypted to each recipient separately.  The trade-off is O(n) DMs per
 * message for n members.
 *
 * ## Persistence
 * Groups (including message history) are persisted to localStorage as JSON.
 * Members and admins are stored as arrays (Sets serialise to [] in JSON) and
 * reconstructed on load.
 */
const GROUP_MSG_MAGIC = 'agora:group:msg:v1:';
const GROUP_SYS_MAGIC = 'agora:group:sys:v1:';

let groups = {};     // { [gid]: { name, members: Set<pubkey>, admins: Set<pubkey>, messages: [], createdAt } }
let activeGroup = null;

function genGroupId()  { return 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function genMsgId()    { return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function loadGroups() {
  try {
    const saved = localStorage.getItem('agora_groups');
    if (saved) {
      const parsed = JSON.parse(saved);
      groups = {};
      for (const [gid, g] of Object.entries(parsed)) {
        groups[gid] = {
          name: g.name || '',
          members: new Set(g.members || []),
          admins: new Set(g.admins || []),
          messages: g.messages || [],
          createdAt: g.createdAt || new Date().toISOString(),
        };
      }
    }
  } catch {}
}

function saveGroups() {
  try {
    const s = {};
    for (const [gid, g] of Object.entries(groups)) {
      s[gid] = { name: g.name, members: [...g.members], admins: [...g.admins], messages: g.messages, createdAt: g.createdAt };
    }
    localStorage.setItem('agora_groups', JSON.stringify(s));
  } catch {}
}

function amAdmin(gid) {
  const g = groups[gid];
  if (!g) return false;
  return g.admins.has(myIdentity?.pubkey);
}

// Encode a group chat message: JSON metadata on the first line, text content after.
// The mid (message ID) is used for client-side deduplication — if the same DM
// arrives twice (e.g., due to a retry) the second copy is silently dropped.
function encodeGroupMsg(gid, mid, content, image) {
  const meta = JSON.stringify({ gid, mid, image: image || undefined });
  return GROUP_MSG_MAGIC + meta + '\n' + content;
}
function parseGroupMsg(raw) {
  if (!raw.startsWith(GROUP_MSG_MAGIC)) return null;
  const rest = raw.slice(GROUP_MSG_MAGIC.length);
  const nl = rest.indexOf('\n');
  if (nl < 0) return null;
  try {
    const meta = JSON.parse(rest.slice(0, nl));
    return { gid: meta.gid, mid: meta.mid, image: meta.image || null, content: rest.slice(nl + 1) };
  } catch { return null; }
}

// Encode a group system/control message (membership changes, admin operations).
function encodeGroupSys(payload) { return GROUP_SYS_MAGIC + JSON.stringify(payload); }
function parseGroupSys(raw) {
  if (!raw.startsWith(GROUP_SYS_MAGIC)) return null;
  try { return JSON.parse(raw.slice(GROUP_SYS_MAGIC.length)); } catch { return null; }
}

/**
 * Send an encoded group message (chat or system) to every member of the group
 * except the current user (we already have our own copy) and any optionally
 * excluded key (used when inviting a new member — we send them their invite
 * directly, not through the general fanout).
 *
 * Each send is independent: a failure to reach one peer does not affect others.
 * Errors are silently caught so a single unreachable peer does not block the UI.
 */
async function fanout(gid, encoded, excludePk) {
  const g = groups[gid];
  if (!g) return;
  const myPk = myIdentity?.pubkey;
  for (const pk of g.members) {
    if (pk === myPk) continue;
    if (excludePk && pk === excludePk) continue;
    await window.agora?.request('send_dm', { recipient: pk, content: encoded }).catch(() => {});
  }
}

async function createGroup(name, memberPubkeys) {
  const gid = genGroupId();
  const myPk = myIdentity?.pubkey;
  const members = new Set([myPk, ...memberPubkeys]);
  const admins  = new Set([myPk]);
  groups[gid] = { name, members, admins, messages: [], createdAt: new Date().toISOString() };
  saveGroups();
  // Notify all members
  const sysMsg = encodeGroupSys({ op: 'create', gid, name, members: [...members], admins: [...admins] });
  await fanout(gid, sysMsg);
  renderGroupList();
  selectGroup(gid);
  toast(`Group "${name}" created`, 'success');
}

async function sendGroupMsg() {
  if (!activeGroup) return;
  const input = document.getElementById('group-msg-input');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  input.style.height = '';
  const mid = genMsgId();
  const encoded = encodeGroupMsg(activeGroup, mid, content);
  const myPk = myIdentity?.pubkey;
  const msg = { mid, own: true, sender_pubkey: myPk, content, image: null, timestamp: new Date().toISOString() };
  groups[activeGroup].messages.push(msg);
  saveGroups();
  appendGroupMessage(msg, true);
  await fanout(activeGroup, encoded);
}

async function kickMember(gid, pk) {
  const g = groups[gid];
  if (!g || !amAdmin(gid)) return;
  g.members.delete(pk);
  g.admins.delete(pk);
  saveGroups();
  const sysMsg = encodeGroupSys({ op: 'kick', gid, pubkey: pk });
  await fanout(gid, sysMsg);
  // Notify the kicked person
  await window.agora?.request('send_dm', { recipient: pk, content: sysMsg }).catch(() => {});
  renderGroupHeader();
  openGroupSettingsModal();
  appendGroupSystemMsg(gid, 'Member removed');
}

async function inviteMemberToGroup(gid, pk) {
  const g = groups[gid];
  if (!g || !amAdmin(gid)) return;
  g.members.add(pk);
  saveGroups();
  // Send them the full group state so they can reconstruct it
  const sysMsg = encodeGroupSys({ op: 'invite', gid, name: g.name, members: [...g.members], admins: [...g.admins] });
  await window.agora?.request('send_dm', { recipient: pk, content: sysMsg }).catch(() => {});
  // Notify existing members
  const notifyMsg = encodeGroupSys({ op: 'member_added', gid, pubkey: pk });
  await fanout(gid, notifyMsg, pk);
  renderGroupHeader();
  openGroupSettingsModal();
  appendGroupSystemMsg(gid, 'New member added');
}

async function promoteAdmin(gid, pk) {
  const g = groups[gid];
  if (!g || !amAdmin(gid)) return;
  g.admins.add(pk);
  saveGroups();
  const sysMsg = encodeGroupSys({ op: 'promote', gid, pubkey: pk });
  await fanout(gid, sysMsg);
  renderGroupHeader();
  openGroupSettingsModal();
}

async function demoteAdmin(gid, pk) {
  const g = groups[gid];
  if (!g || !amAdmin(gid)) return;
  g.admins.delete(pk);
  saveGroups();
  const sysMsg = encodeGroupSys({ op: 'demote', gid, pubkey: pk });
  await fanout(gid, sysMsg);
  renderGroupHeader();
  openGroupSettingsModal();
}

async function leaveOrDisbandGroup() {
  if (!activeGroup) return;
  const g = groups[activeGroup];
  if (!g) return;
  const gid = activeGroup;
  const myPk = myIdentity?.pubkey;
  if (!confirm(`Leave "${g.name}"?`)) return;
  closeModal('group-settings-modal');
  const sysMsg = encodeGroupSys({ op: 'leave', gid, pubkey: myPk });
  await fanout(gid, sysMsg);
  delete groups[gid];
  saveGroups();
  activeGroup = null;
  renderGroupList();
  showGroupEmpty(true);
  toast('Left group', 'info');
}

// ── Incoming group DM routing ──────────────────────────────────────────────────
/**
 * Router called from handleDaemonEvent when a DM content starts with one of the
 * group magic prefixes.  Delegates to handleGroupMsg or handleGroupSys based on
 * which magic prefix was matched.
 */
function handleGroupDm(d) {
  const raw = d.content || '';
  const gmsg = parseGroupMsg(raw);
  if (gmsg) { handleGroupMsg(d, gmsg); return; }
  const gsys = parseGroupSys(raw);
  if (gsys) { handleGroupSys(d, gsys); }
}

function handleGroupMsg(d, gmsg) {
  const { gid, mid, image, content } = gmsg;
  const g = groups[gid];
  if (!g) return; // unknown group — ignore spurious messages
  if (!g.members.has(d.sender_pubkey)) return; // reject messages from non-members
  // Deduplicate by message ID to handle retry/duplicate delivery gracefully.
  if (g.messages.some(m => m.mid === mid)) return;
  const msg = { mid, own: false, sender_pubkey: d.sender_pubkey, content, image: image || null, timestamp: d.timestamp || new Date().toISOString() };
  g.messages.push(msg);
  saveGroups();
  if (activeGroup === gid) appendGroupMessage(msg, true);
  else toast(`💬 [${g.name}] ${peerName(d.sender_pubkey)}: ${content.slice(0, 50)}`, 'info');
}

/**
 * Handle an incoming group system event.  The full set of ops:
 *   create / invite — reconstruct the group from the embedded member/admin lists.
 *   kick            — remove a member (or us if pubkey === myPk).
 *   leave           — sender voluntarily left; remove them from member/admin lists.
 *   member_added    — an admin added someone new; add to member list.
 *   promote         — grant admin status.
 *   demote          — revoke admin status.
 */
function handleGroupSys(d, gsys) {
  const { op, gid } = gsys;
  const myPk = myIdentity?.pubkey;

  if (op === 'create' || op === 'invite') {
    // Reconstruct group from system message.  Both ops carry the full group
    // state (name, members, admins) so any member can bootstrap from it.
    if (!groups[gid]) {
      groups[gid] = { name: gsys.name, members: new Set(gsys.members || []), admins: new Set(gsys.admins || []), messages: [], createdAt: new Date().toISOString() };
      saveGroups();
      renderGroupList();
      toast(`You were added to group "${gsys.name}"`, 'success');
    }
    return;
  }

  const g = groups[gid];
  if (!g) return;

  if (op === 'kick' && gsys.pubkey === myPk) {
    if (activeGroup === gid) { activeGroup = null; showGroupEmpty(true); }
    delete groups[gid];
    saveGroups();
    renderGroupList();
    toast('You were removed from a group', 'error');
  } else if (op === 'kick') {
    g.members.delete(gsys.pubkey);
    g.admins.delete(gsys.pubkey);
    saveGroups();
    if (activeGroup === gid) { renderGroupHeader(); appendGroupSystemMsg(gid, peerName(gsys.pubkey) + ' was removed'); }
  } else if (op === 'member_added') {
    g.members.add(gsys.pubkey);
    saveGroups();
    if (activeGroup === gid) { renderGroupHeader(); appendGroupSystemMsg(gid, peerName(gsys.pubkey) + ' joined'); }
  } else if (op === 'leave') {
    g.members.delete(gsys.pubkey);
    g.admins.delete(gsys.pubkey);
    saveGroups();
    if (activeGroup === gid) { renderGroupHeader(); appendGroupSystemMsg(gid, peerName(gsys.pubkey) + ' left'); }
  } else if (op === 'promote') {
    g.admins.add(gsys.pubkey);
    saveGroups();
    if (activeGroup === gid) { renderGroupHeader(); }
  } else if (op === 'demote') {
    g.admins.delete(gsys.pubkey);
    saveGroups();
    if (activeGroup === gid) { renderGroupHeader(); }
  }
}

// ── Group UI ───────────────────────────────────────────────────────────────────
function peerName(pk) {
  if (!pk) return 'unknown';
  if (pk === myIdentity?.pubkey) return 'You';
  const peer = peers.find(p => p.pubkey === pk);
  return peer?.username || peer?.fingerprint?.slice(0, 10) || pk.slice(0, 10);
}

function showGroupEmpty(show) {
  const noGroup = document.getElementById('no-group');
  const pane    = document.getElementById('group-chat-pane');
  if (noGroup) noGroup.style.display = show ? '' : 'none';
  if (pane)    { pane.style.display = show ? 'none' : 'flex'; pane.style.flexDirection = show ? '' : 'column'; }
}

function renderGroupList() {
  // In the groups tab the sidebar peer-list shows groups
  if (activeTab !== 'groups') return;
  const list = document.getElementById('peer-list');
  if (!list) return;
  const entries = Object.entries(groups);
  if (entries.length === 0) {
    list.innerHTML = '<div class="peer-empty">No groups yet.<br/>Create one below.</div>';
    return;
  }
  list.innerHTML = entries.map(([gid, g]) => {
    const initial = (g.name || '?')[0].toUpperCase();
    const memberCount = g.members.size;
    const isActive = gid === activeGroup;
    const lastMsg = g.messages[g.messages.length - 1];
    const lastText = lastMsg ? lastMsg.content.slice(0, 30) : 'No messages yet';
    return `<div class="group-item${isActive ? ' active' : ''}" onclick="selectGroup('${escHtml(gid)}')">
      <div class="group-avatar-sm">${escHtml(initial)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(g.name)}</div>
        <div class="group-item-meta">${memberCount} members · ${escHtml(lastText)}</div>
      </div>
    </div>`;
  }).join('');
}

function selectGroup(gid) {
  if (!groups[gid]) return;
  activeGroup = gid;
  renderGroupList();
  showGroupEmpty(false);
  renderGroupHeader();
  renderGroupMessages();
  // Auto-scroll
  const msgs = document.getElementById('group-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
  // Set up Enter key
  const inp = document.getElementById('group-msg-input');
  if (inp) {
    inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGroupMsg(); } };
    inp.oninput = () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px'; };
    inp.focus();
  }
}

function renderGroupHeader() {
  if (!activeGroup || !groups[activeGroup]) return;
  const g = groups[activeGroup];
  const avatarEl = document.getElementById('group-chat-avatar');
  const nameEl   = document.getElementById('group-chat-name');
  const membersEl = document.getElementById('group-chat-members');
  if (avatarEl) avatarEl.textContent = (g.name || '?')[0].toUpperCase();
  if (nameEl) nameEl.textContent = g.name;
  if (membersEl) membersEl.textContent = g.members.size + ' member' + (g.members.size !== 1 ? 's' : '') + (amAdmin(activeGroup) ? ' · admin' : '');
}

function renderGroupMessages() {
  const container = document.getElementById('group-messages');
  if (!container || !activeGroup || !groups[activeGroup]) return;
  const g = groups[activeGroup];
  if (g.messages.length === 0) {
    container.innerHTML = '<div style="text-align:center;font-family:var(--mono);font-size:11px;color:var(--text-muted);padding:20px">No messages yet. Say hello!</div>';
    return;
  }
  container.innerHTML = '';
  for (const m of g.messages) appendGroupMessage(m, false);
}

function appendGroupMessage(m, scroll) {
  const container = document.getElementById('group-messages');
  if (!container) return;
  const own   = !!m.own;
  const name  = own ? 'You' : peerName(m.sender_pubkey);
  let timeStr = '';
  try { timeStr = formatTime(m.timestamp); } catch {}
  const imageHtml = m.image ? `<div class="post-image" style="margin-top:4px"><img src="${escHtml(m.image)}" alt="image" onclick="openImageViewer(this.src)" style="max-width:100%;border-radius:6px"/></div>` : '';
  const div = document.createElement('div');
  div.className = 'msg' + (own ? ' own' : '');
  div.innerHTML = `
    <div class="msg-sender" style="font-size:10px;font-family:var(--mono);color:${own ? 'var(--accent)' : 'var(--text-dim)'};margin-bottom:2px">${escHtml(name)}</div>
    <div class="msg-bubble">${escHtml(m.content)}${imageHtml}</div>
    <div class="msg-time">${escHtml(timeStr)}</div>`;
  container.appendChild(div);
  if (scroll) container.scrollTop = container.scrollHeight;
}

function appendGroupSystemMsg(gid, text) {
  if (activeGroup !== gid) return;
  const container = document.getElementById('group-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.style.cssText = 'text-align:center;font-family:var(--mono);font-size:10px;color:var(--text-muted);padding:6px 0;opacity:.7';
  div.textContent = '— ' + text + ' —';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function openCreateGroupModal() {
  const picker = document.getElementById('create-group-peer-picker');
  const nameIn = document.getElementById('new-group-name-input');
  if (nameIn) nameIn.value = '';
  if (picker) {
    const available = peers.filter(p => !isBlocked(p.pubkey) && !blockedByPubkeys.has(p.pubkey));
    if (available.length === 0) {
      picker.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text-muted);padding:8px">No peers available to add.</div>';
    } else {
      picker.innerHTML = available.map(p => {
        const name = p.username || p.fingerprint || p.pubkey.slice(0, 10);
        const fp   = p.fingerprint || p.pubkey.slice(0, 24);
        return `<label class="group-pick-item">
          <input type="checkbox" class="group-pick-check" value="${escHtml(p.pubkey)}"/>
          <div><div class="group-pick-name">${escHtml(name)}</div><div class="group-pick-fp">${escHtml(fp)}</div></div>
        </label>`;
      }).join('');
    }
  }
  document.getElementById('create-group-modal').classList.add('open');
}

function submitCreateGroup() {
  const nameIn = document.getElementById('new-group-name-input');
  const name = nameIn?.value.trim();
  if (!name) { toast('Enter a group name', 'error'); return; }
  const checks = document.querySelectorAll('#create-group-peer-picker .group-pick-check:checked');
  const memberPks = [...checks].map(c => c.value);
  closeModal('create-group-modal');
  createGroup(name, memberPks);
}

function openGroupSettingsModal() {
  if (!activeGroup || !groups[activeGroup]) return;
  const g = groups[activeGroup];
  const isAdmin = amAdmin(activeGroup);

  const titleEl = document.getElementById('gs-title');
  if (titleEl) titleEl.textContent = g.name + ' — Settings';

  // Members list
  const membersEl = document.getElementById('gs-members-list');
  if (membersEl) {
    const myPk = myIdentity?.pubkey;
    membersEl.innerHTML = [...g.members].map(pk => {
      const name = peerName(pk);
      const fp   = peers.find(p => p.pubkey === pk)?.fingerprint || pk.slice(0, 20) + '…';
      const isAdm = g.admins.has(pk);
      const isSelf = pk === myPk;
      let actions = '';
      if (isAdmin && !isSelf) {
        if (isAdm) {
          actions += `<button class="btn-sm" onclick="demoteAdmin('${escHtml(activeGroup)}','${escHtml(pk)}')">Demote</button>`;
        } else {
          actions += `<button class="btn-sm" onclick="promoteAdmin('${escHtml(activeGroup)}','${escHtml(pk)}')">Make admin</button>`;
        }
        actions += `<button class="btn-danger" onclick="kickMember('${escHtml(activeGroup)}','${escHtml(pk)}')">Remove</button>`;
      }
      return `<div class="group-member-row">
        <div class="group-member-info">
          <div class="group-member-name">${escHtml(name)}${isAdm ? ' <span class="group-admin-badge">admin</span>' : ''}</div>
          <div class="group-member-fp">${escHtml(fp)}</div>
        </div>
        <div class="group-member-actions">${actions}</div>
      </div>`;
    }).join('');
  }

  // Add members section (admin only)
  const addSection = document.getElementById('gs-add-section');
  if (addSection) addSection.style.display = isAdmin ? '' : 'none';
  if (isAdmin) {
    const gsPicker = document.getElementById('gs-peer-picker');
    if (gsPicker) {
      const notInGroup = peers.filter(p => !g.members.has(p.pubkey) && !isBlocked(p.pubkey));
      if (notInGroup.length === 0) {
        gsPicker.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text-muted);padding:6px">No peers to add.</div>';
      } else {
        gsPicker.innerHTML = notInGroup.map(p => {
          const name = p.username || p.fingerprint || p.pubkey.slice(0, 10);
          const fp   = p.fingerprint || p.pubkey.slice(0, 20);
          return `<label class="group-pick-item">
            <input type="checkbox" class="gs-pick-check" value="${escHtml(p.pubkey)}"/>
            <div><div class="group-pick-name">${escHtml(name)}</div><div class="group-pick-fp">${escHtml(fp)}</div></div>
          </label>`;
        }).join('');
      }
    }
  }

  // Leave button label
  const leaveBtn = document.getElementById('gs-leave-btn');
  if (leaveBtn) leaveBtn.textContent = 'Leave Group';

  document.getElementById('group-settings-modal').classList.add('open');
}

async function addSelectedPeersToGroup() {
  if (!activeGroup) return;
  const checks = document.querySelectorAll('#gs-peer-picker .gs-pick-check:checked');
  const pks = [...checks].map(c => c.value);
  for (const pk of pks) await inviteMemberToGroup(activeGroup, pk);
  if (pks.length === 0) { toast('No peers selected', 'error'); return; }
  openGroupSettingsModal(); // re-render
}

/**
 * Core import logic shared by manual import, subscribe, and auto-update paths.
 * Adds pubkeys (and optionally channel names) to the specified owned blocklist,
 * deduplicating against existing entries.
 *
 * For each newly blocked pubkey, a BLOCK_SIGNAL DM is sent so the peer's client
 * knows to show the "blocked you" notice.
 *
 * `silent = true` suppresses the toast notification (used for background auto-import).
 * Returns the total number of new items added (pubkeys + channels combined).
 */
function importBlocklistPubkeys(pubkeys, listId, silent = false, channels = []) {
  if (!blocklists[listId] || !blocklists[listId].owned) listId = getDefaultOwnedListId();
  const list = blocklists[listId];
  if (!list.channels) list.channels = new Set();
  let added = 0;
  for (const pk of pubkeys) {
    if (typeof pk === 'string' && pk && pk !== myIdentity?.pubkey && !list.pubkeys.has(pk)) {
      if (window.agora?.request) {
        window.agora.request('send_dm', { recipient: pk, content: BLOCK_SIGNAL }).catch(() => {});
      }
      list.pubkeys.add(pk);
      added++;
    }
  }
  let addedCh = 0;
  for (const ch of channels) {
    if (typeof ch === 'string' && ch && !list.channels.has(ch)) {
      list.channels.add(ch);
      addedCh++;
    }
  }
  if (added > 0 || addedCh > 0) {
    saveBlocklists();
    renderPeerList();
    renderFeed();
    if (!silent) {
      const parts = [];
      if (added > 0) parts.push(`${added} blocked user(s)`);
      if (addedCh > 0) parts.push(`${addedCh} blocked channel(s)`);
      toast(`Imported ${parts.join(' and ')}`, 'success');
    }
  }
  return added + addedCh;
}

function subscribeToBlocklist(senderPubkey, listName = DEFAULT_LIST_NAME) {
  const key = subKey(senderPubkey, listName);
  subscribedToBlocklists.add(key);
  saveSubscriptions();
  // Immediately import the most recent matching blocklist post from this peer
  const latest = posts
    .filter(p => p.sender_pubkey === senderPubkey)
    .map(p => ({ p, bl: parseBlocklistPost(p.content) }))
    .filter(x => x.bl && (x.bl.list_name || DEFAULT_LIST_NAME) === listName)
    .sort((a, b) => new Date(b.p.timestamp) - new Date(a.p.timestamp))[0];
  if (latest) {
    const importId = getOrCreateOwnedList('Imported from ' + (latest.p.sender_username || senderPubkey.slice(0, 8)));
    importBlocklistPubkeys(latest.bl.pubkeys, importId, true, latest.bl.channels || []);
  }
  toast('Subscribed — blocklist will auto-update when they re-broadcast', 'success');
  renderFeed();
}

function unsubscribeFromBlocklist(senderPubkey, listName = DEFAULT_LIST_NAME) {
  subscribedToBlocklists.delete(subKey(senderPubkey, listName));
  saveSubscriptions();
  toast('Unsubscribed from blocklist', 'info');
  renderFeed();
}
