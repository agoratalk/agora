// ── Follow list import / subscribe ────────────────────────────────────────────
/**
 * lists.js — Sharing, importing, and subscribing to follow lists and blocklists.
 *
 * Follow lists and blocklists can be published as broadcast posts so other peers
 * can discover and import them.  This file handles:
 *   - importFollowlistPubkeys / importBlocklistPubkeys: merge received list data
 *     into the local named list, optionally notifying the user.
 *   - openFollowModal / openBlockedModal / openFollowersModal: the UI modals for
 *     managing lists and subscriptions.
 *   - renderBlocklistsModal / renderFollowlistsModal: build the accordion UI that
 *     shows each named list with its members and action buttons.
 *   - publishBlocklist / publishFollowlist: broadcast the current list contents so
 *     subscribed peers receive an updated copy.
 *   - createNewBlocklist / createNewFollowlist: prompt-based helpers.
 */
function importFollowlistPubkeys(pubkeys, listId, silent = false, channels = []) {
  if (!followlists[listId] || !followlists[listId].owned) listId = getDefaultFollowListId();
  const list = followlists[listId];
  if (!list.channels) list.channels = new Set();
  let added = 0;
  for (const pk of pubkeys) {
    if (typeof pk === 'string' && pk && pk !== myIdentity?.pubkey && !list.pubkeys.has(pk)) {
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
    saveFollowlists();
    renderPeerList();
    renderFeed();
    if (!silent) {
      const parts = [];
      if (added > 0) parts.push(`${added} followed user(s)`);
      if (addedCh > 0) parts.push(`${addedCh} followed channel(s)`);
      toast(`Imported ${parts.join(' and ')}`, 'success');
    }
  }
  return added + addedCh;
}

function importFollowlist(pubkeysJson, listName, channelsJson = null) {
  let pubkeys;
  try { pubkeys = JSON.parse(pubkeysJson); } catch { toast('Invalid follow list data', 'error'); return; }
  if (!Array.isArray(pubkeys)) { toast('Invalid follow list data', 'error'); return; }
  let channels = [];
  if (channelsJson) { try { channels = JSON.parse(channelsJson); } catch {} }
  const listId = getOrCreateFollowList(listName || DEFAULT_FOLLOW_LIST);
  const added = importFollowlistPubkeys(pubkeys, listId, false, channels);
  if (added === 0) toast('Nothing new to import — all already followed', 'info');
}

function subscribeToFollowlist(senderPubkey, listName = DEFAULT_FOLLOW_LIST) {
  const key = subKey(senderPubkey, listName);
  subscribedToFollowlists.add(key);
  saveFollowlistSubs();
  const latest = posts
    .filter(p => p.sender_pubkey === senderPubkey)
    .map(p => ({ p, fl: parseFollowlistPost(p.content) }))
    .filter(x => x.fl && (x.fl.list_name || DEFAULT_FOLLOW_LIST) === listName)
    .sort((a, b) => new Date(b.p.timestamp) - new Date(a.p.timestamp))[0];
  if (latest) {
    const listId = getOrCreateFollowList('Imported from ' + (latest.p.sender_username || senderPubkey.slice(0, 8)));
    importFollowlistPubkeys(latest.fl.pubkeys, listId, true, latest.fl.channels || []);
  }
  toast('Subscribed — follow list will auto-update when they re-broadcast', 'success');
  renderFeed();
}

function unsubscribeFromFollowlist(senderPubkey, listName = DEFAULT_FOLLOW_LIST) {
  subscribedToFollowlists.delete(subKey(senderPubkey, listName));
  saveFollowlistSubs();
  toast('Unsubscribed from follow list', 'info');
  renderFeed();
}

function updateBlockedIndicator() {
  const n = allBlockedPubkeys().size;
  const btn = document.getElementById('blocked-indicator');
  const cnt = document.getElementById('blocked-count');
  if (btn) btn.classList.toggle('has-blocked', n > 0);
  if (cnt) cnt.textContent = n;
}

/**
 * Block a peer and add them to the specified owned blocklist.
 *
 * Side effects:
 *   1. Sends a BLOCK_SIGNAL DM to the peer so their client shows "blocked you".
 *   2. Adds to the blocklist and persists to localStorage.
 *   3. If the chat view is currently open for this peer, closes it.
 *   4. Re-renders the peer list and feed to hide the blocked user immediately.
 */
function blockPeer(pubkey, listId) {
  if (!listId) listId = getDefaultOwnedListId();
  // Send a silent signal to the blocked peer's client so their UI knows not to contact us
  if (window.agora?.request) {
    window.agora.request('send_dm', { recipient: pubkey, content: BLOCK_SIGNAL }).catch(() => {});
  }
  blocklists[listId].pubkeys.add(pubkey);
  saveBlocklists();
  // If currently viewing this peer's chat, clear it
  if (activePeer === pubkey) {
    activePeer = null;
    document.getElementById('no-peer').style.display = 'flex';
    document.getElementById('chat-header').style.display = 'none';
    document.getElementById('messages').style.display = 'none';
    document.getElementById('input-bar').style.display = 'none';
    document.getElementById('blocked-by-notice').classList.remove('show');
  }
  renderPeerList();
  renderFeed();
  toast('User blocked', 'success');
}

function unblockPeer(pubkey, listId) {
  if (listId) {
    blocklists[listId]?.pubkeys.delete(pubkey);
  } else {
    for (const list of Object.values(blocklists)) list.pubkeys.delete(pubkey);
  }
  saveBlocklists();
  renderPeerList();
  renderFeed();
  renderBlockedModal();
  toast('User unblocked', 'success');
}

let _blockPickerTarget = null;

function confirmBlockPeer(pubkey) {
  const ownedLists = Object.entries(blocklists).filter(([, l]) => l.owned);
  const peer = peers.find(p => p.pubkey === pubkey);
  const name = peer?.username || peer?.fingerprint || pubkey.slice(0, 12);
  if (ownedLists.length <= 1) {
    if (!confirm(`Block ${name}?\n\nThey will be hidden from your peers list, feed, and DMs.`)) return;
    blockPeer(pubkey, ownedLists[0]?.[0]);
  } else {
    showBlockPicker(pubkey);
  }
}

function showBlockPicker(pubkey) {
  _blockPickerTarget = pubkey;
  const peer = peers.find(p => p.pubkey === pubkey);
  const name = peer?.username || peer?.fingerprint || pubkey.slice(0, 12);
  document.getElementById('block-picker-name').textContent = `Block "${name}" — choose a list:`;
  const listsEl = document.getElementById('block-picker-lists');
  const ownedLists = Object.entries(blocklists).filter(([, l]) => l.owned);
  listsEl.innerHTML = ownedLists.map(([id, list]) =>
    `<button class="block-picker-btn" onclick="performBlock('${escHtml(pubkey)}','${escHtml(id)}')">${escHtml(list.name)} <span style="opacity:.5;font-size:9px">${list.pubkeys.size} users</span></button>`
  ).join('') +
  `<button class="block-picker-btn block-picker-new" onclick="blockPickerNewList('${escHtml(pubkey)}')">+ New list…</button>`;
  document.getElementById('block-picker-modal').classList.add('open');
}

function performBlock(pubkey, listId) {
  closeModal('block-picker-modal');
  blockPeer(pubkey, listId);
}

function blockPickerNewList(pubkey) {
  const name = prompt('New blocklist name:');
  if (!name?.trim()) return;
  const id = newListId();
  blocklists[id] = { name: name.trim(), pubkeys: new Set(), owned: true };
  closeModal('block-picker-modal');
  blockPeer(pubkey, id);
}

function toggleBlockActivePeer() {
  if (!activePeer) return;
  if (isBlocked(activePeer)) {
    unblockPeer(activePeer);
    updateChatBlockBtn();
  } else {
    confirmBlockPeer(activePeer);
    updateChatBlockBtn();
  }
}

function updateChatBlockBtn() {
  if (!activePeer) return;
  const blockItem = document.getElementById('chat-block-btn');
  if (blockItem) {
    const blocked = isBlocked(activePeer);
    blockItem.textContent = blocked ? 'Unblock' : 'Block';
    blockItem.classList.toggle('danger', !blocked);
  }
  const followItem = document.getElementById('chat-follow-item');
  if (followItem) {
    followItem.textContent = isFollowing(activePeer) ? 'Unfollow' : 'Follow';
    followItem.classList.toggle('is-active', isFollowing(activePeer));
  }
}

function toggleFollowActivePeer() {
  if (!activePeer) return;
  toggleFollowPeer(activePeer);
  updateChatBlockBtn();
}

function createNewBlocklist() {
  const name = prompt('New blocklist name:');
  if (!name?.trim()) return;
  const id = newListId();
  blocklists[id] = { name: name.trim(), pubkeys: new Set(), owned: true };
  saveBlocklists();
  renderBlockedModal();
  toast(`Created list "${name.trim()}"`, 'success');
}

function deleteBlocklist(id) {
  const list = blocklists[id];
  if (!list) return;
  if (!confirm(`Delete blocklist "${list.name}"?\n\nUsers in this list will be unblocked.`)) return;
  delete blocklists[id];
  saveBlocklists();
  renderPeerList();
  renderFeed();
  renderBlockedModal();
  toast('Blocklist deleted', 'info');
}

function updateInputBarBlockedBy() {
  const notice = document.getElementById('blocked-by-notice');
  const bar = document.getElementById('input-bar');
  const isBlockedBy = activePeer && blockedByPubkeys.has(activePeer);
  if (notice) notice.classList.toggle('show', !!isBlockedBy);
  if (bar) bar.style.display = isBlockedBy ? 'none' : (activePeer ? 'flex' : 'none');
}

function openBlockedModal() {
  renderBlockedModal();
  document.getElementById('blocked-modal').classList.add('open');
}

function renderBlockedModal() {
  // Blocked channels section
  const chSection = document.getElementById('blocked-channels-section');
  const chList    = document.getElementById('blocked-channels-list');
  if (chSection && chList) {
    if (blockedChannels.size > 0) {
      chSection.style.display = '';
      chList.innerHTML = [...blockedChannels].sort().map(name =>
        `<div class="bl-ch-row"><span>#${escHtml(name)}</span><button class="btn-sm" onclick="unblockChannel('${escHtml(name)}')">Unblock</button></div>`
      ).join('');
    } else {
      chSection.style.display = 'none';
    }
  }
  const container = document.getElementById('blocklists-container');
  if (!container) return;
  const ownedLists = Object.entries(blocklists).filter(([, l]) => l.owned);
  if (ownedLists.length === 0) {
    container.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text-muted);padding:8px 0">No blocklists yet. Create one or block a user.</div>';
    return;
  }
  container.innerHTML = ownedLists.map(([id, list]) => {
    const channels = list.channels || new Set();
    const userEntries = [...list.pubkeys].map(pk => {
      const peer = peers.find(p => p.pubkey === pk);
      const post = posts.find(p => p.sender_pubkey === pk);
      const name = peer?.username || post?.sender_username || '(unknown)';
      const fp   = peer?.fingerprint || post?.sender_fingerprint || pk.slice(0, 24) + '…';
      return `<div class="bl-user-row">
        <div class="bl-user-info">
          <div class="bl-user-name">${escHtml(name)}</div>
          <div class="bl-user-fp">${escHtml(fp)}</div>
        </div>
        <button class="btn-sm" onclick="unblockPeer('${escHtml(pk)}','${escHtml(id)}')" title="Remove from list">Remove</button>
      </div>`;
    }).join('');
    const channelEntries = [...channels].map(ch =>
      `<div class="bl-user-row">
        <div class="bl-user-info">
          <div class="bl-user-name">#${escHtml(ch)}</div>
          <div class="bl-user-fp">channel</div>
        </div>
        <button class="btn-sm" onclick="removeChannelFromBlocklist('${escHtml(id)}','${escHtml(ch)}')" title="Unblock channel">Remove</button>
      </div>`
    ).join('');
    const totalCount = list.pubkeys.size + channels.size;
    const countLabel = `${list.pubkeys.size} user${list.pubkeys.size !== 1 ? 's' : ''}${channels.size > 0 ? `, ${channels.size} channel${channels.size !== 1 ? 's' : ''}` : ''}`;
    return `<div class="bl-section">
      <div class="bl-section-header">
        <span class="bl-section-name">${escHtml(list.name)}</span>
        <span class="bl-section-count">${countLabel}</span>
        <div class="bl-section-actions">
          <button class="btn-sm" onclick="promptAddChannelToBlocklist('${escHtml(id)}')" title="Block a channel">+ Channel</button>
          <button class="btn-sm" onclick="openPublishBlocklistPicker('${escHtml(id)}')" title="Publish this list">📢 Publish</button>
          <button class="btn-danger" onclick="deleteBlocklist('${escHtml(id)}')" title="Delete list">✕</button>
        </div>
      </div>
      <div class="bl-section-body">
        ${userEntries}${channelEntries}${totalCount === 0 ? '<div class="bl-empty">No users or channels in this list</div>' : ''}
      </div>
    </div>`;
  }).join('');
}

// ── Blocklist sharing ──────────────────────────────────────────────────────────
/**
 * Blocklist sharing: the user publishes their blocklist as a normal broadcast
 * post so other users can discover and subscribe to it.
 *
 * Wire format: "agora:blocklist:v1:" + JSON({ list_name, pubkeys, names, channels })
 *   - `pubkeys`: array of blocked pubkeys
 *   - `names`:   pubkey → display name map (informational, not trusted for identity)
 *   - `channels`: array of blocked channel names
 *
 * A published blocklist post renders as a special card in the feed with
 * "Import All" and "Subscribe" buttons.  Subscribers auto-import on every
 * re-broadcast (every 30 minutes by the publisher's client).
 *
 * The list can be published to a specific channel by wrapping it in the channel
 * encoding format, so community-specific blocklists stay in their channel.
 */
const BLOCKLIST_MAGIC = 'agora:blocklist:v1:';

async function publishBlocklist(listId, silent = false, targetChannel = null) {
  const list = blocklists[listId];
  if (!list || !list.owned) { if (!silent) toast('List not found', 'error'); return; }
  if (list.pubkeys.size === 0 && (!list.channels || list.channels.size === 0)) { if (!silent) toast('No blocked users or channels to publish', 'error'); return; }
  const names = {};
  for (const pk of list.pubkeys) {
    const peer = peers.find(p => p.pubkey === pk);
    const post = posts.find(p => p.sender_pubkey === pk);
    names[pk] = peer?.username || post?.sender_username || peer?.fingerprint || post?.sender_fingerprint || '';
  }
  const payload = JSON.stringify({ list_name: list.name, pubkeys: [...list.pubkeys], names, channels: [...(list.channels || [])] });
  let content = BLOCKLIST_MAGIC + payload;
  if (targetChannel) content = encodeChannelPost(targetChannel, content);
  const resp = await window.agora?.request('broadcast', { content });
  if (resp?.error) { if (!silent) toast('Failed to publish: ' + resp.error, 'error'); return; }
  if (!silent) {
    closeModal('blocked-modal');
    const dest = targetChannel ? `to #${targetChannel}` : 'to the network';
    toast(`Blocklist "${list.name}" published ${dest}`, 'success');
    await refreshPosts();
  }
}

function parseBlocklistPost(content) {
  if (!content.startsWith(BLOCKLIST_MAGIC)) return null;
  try {
    const parsed = JSON.parse(content.slice(BLOCKLIST_MAGIC.length));
    if (!parsed.list_name) parsed.list_name = DEFAULT_LIST_NAME;
    return parsed;
  } catch { return null; }
}

function importBlocklist(pubkeysJson, listName, channelsJson = null) {
  let pubkeys;
  try { pubkeys = JSON.parse(pubkeysJson); } catch { toast('Invalid blocklist data', 'error'); return; }
  if (!Array.isArray(pubkeys)) { toast('Invalid blocklist data', 'error'); return; }
  let channels = [];
  if (channelsJson) { try { channels = JSON.parse(channelsJson); } catch {} }
  const listId = getOrCreateOwnedList(listName || DEFAULT_LIST_NAME);
  const added = importBlocklistPubkeys(pubkeys, listId, false, channels);
  if (added === 0) toast('Nothing new to import — all already blocked', 'info');
}

// Fetch the active identity from the daemon and update the sidebar identity card.
// Also repopulates the peerAvatars/peerBios caches for our own pubkey so our
// avatar shows correctly in outgoing messages.
async function refreshIdentity() {
  const resp = await window.agora.request('whoami', {});
  if (resp?.result) {
    myIdentity = resp.result;
    document.getElementById('my-name').textContent = myIdentity.username || myIdentity.fingerprint;
    document.getElementById('my-fp').textContent = myIdentity.pubkey.slice(0, 28) + '…';
    document.getElementById('my-account').textContent = myIdentity.account_name || 'default';
    if (myIdentity.pubkey) {
      if (myIdentity.avatar) peerAvatars[myIdentity.pubkey] = myIdentity.avatar;
      else delete peerAvatars[myIdentity.pubkey];
      if (myIdentity.bio) peerBios[myIdentity.pubkey] = myIdentity.bio;
      else delete peerBios[myIdentity.pubkey];
    }
    renderIdentityAvatar();
  }
}

// Fetch the live peer list from the daemon, update the avatar/bio caches for
// all known peers, and re-render the peer sidebar.
async function refreshPeers() {
  const resp = await window.agora.request('peers', {});
  if (resp?.result) {
    peers = resp.result;
    for (const p of peers) {
      if (p.pubkey) {
        if (p.avatar) peerAvatars[p.pubkey] = p.avatar;
        else if (!peerAvatars[p.pubkey]) delete peerAvatars[p.pubkey];
        if (p.bio) peerBios[p.pubkey] = p.bio;
      }
    }
    renderPeerList();
  }
}
