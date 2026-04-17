// ── Follow system ──────────────────────────────────────────────────────────────
/**
 * The follow system mirrors the blocklist architecture: named follow lists
 * (multiple allowed), owned by the local user.  A followed peer's posts appear
 * in the "Following" feed, and the peer list is sorted to show followed+unread
 * peers first.
 *
 * Following a peer sends a FOLLOW_SIGNAL DM so the peer's client can add us to
 * their known-followers list immediately without requiring them to receive our
 * follow list broadcast.
 *
 * Follow lists can be published as broadcasts so others can subscribe and
 * auto-import them.  Wire format (same broadcast-with-magic pattern as blocklists):
 *   "agora:followlist:v1:" + JSON({ list_name, pubkeys, names, channels })
 *
 * Channel follows work the same way: a followed channel's posts appear in the
 * Following feed regardless of who sent them.
 */
const DEFAULT_FOLLOW_LIST = 'Following';
const FOLLOWLIST_MAGIC = 'agora:followlist:v1:';

function isFollowing(pk) {
  if (!pk) return false;
  for (const list of Object.values(followlists)) {
    if (list.owned && list.pubkeys.has(pk)) return true;
  }
  return false;
}

function isFollowingChannel(name) {
  if (!name) return false;
  for (const list of Object.values(followlists)) {
    if (list.owned && list.channels && list.channels.has(name)) return true;
  }
  return false;
}

function followChannel(name) {
  const listId = getOrCreateFollowList(DEFAULT_FOLLOW_LIST);
  addChannelToFollowlist(listId, name);
  updateChannelMenuBtn();
  updateFollowingIndicator();
}

function unfollowChannel(name) {
  for (const [id, list] of Object.entries(followlists)) {
    if (list.owned && list.channels && list.channels.has(name)) {
      removeChannelFromFollowlist(id, name);
    }
  }
  updateChannelMenuBtn();
  updateFollowingIndicator();
}

function toggleFollowActiveChannel() {
  closeChannelMenu();
  if (!activeChannel) return;
  if (isFollowingChannel(activeChannel)) unfollowChannel(activeChannel);
  else followChannel(activeChannel);
}

function allFollowedPubkeys() {
  const all = new Set();
  for (const list of Object.values(followlists)) {
    if (list.owned) for (const pk of list.pubkeys) all.add(pk);
  }
  return all;
}

function allFollowedChannels() {
  const all = new Set();
  for (const list of Object.values(followlists)) {
    if (list.owned) for (const ch of (list.channels || [])) all.add(ch);
  }
  return all;
}

function isChannelBlockedByList(name) {
  for (const list of Object.values(blocklists)) {
    if (list.owned && list.channels && list.channels.has(name)) return true;
  }
  return false;
}

function newFollowListId() {
  return 'fl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getOrCreateFollowList(name) {
  for (const [id, list] of Object.entries(followlists)) {
    if (list.owned && list.name === name) return id;
  }
  const id = newFollowListId();
  followlists[id] = { name, pubkeys: new Set(), channels: new Set(), owned: true };
  return id;
}

function getDefaultFollowListId() {
  for (const [id, list] of Object.entries(followlists)) {
    if (list.owned) return id;
  }
  return getOrCreateFollowList(DEFAULT_FOLLOW_LIST);
}

function loadFollowlists() {
  try {
    const saved = localStorage.getItem('agora_followlists');
    if (saved) {
      const parsed = JSON.parse(saved);
      followlists = {};
      for (const [id, list] of Object.entries(parsed)) {
        followlists[id] = { name: list.name, pubkeys: new Set(list.pubkeys || []), channels: new Set(list.channels || []), owned: !!list.owned };
      }
    }
  } catch {}
  updateFollowingIndicator();
}

function saveFollowlists() {
  try {
    const serializable = {};
    for (const [id, list] of Object.entries(followlists)) {
      serializable[id] = { name: list.name, pubkeys: [...list.pubkeys], channels: [...(list.channels || [])], owned: list.owned };
    }
    localStorage.setItem('agora_followlists', JSON.stringify(serializable));
  } catch {}
  updateFollowingIndicator();
}

function updateFollowingIndicator() {
  const users = allFollowedPubkeys().size;
  const channels = allFollowedChannels().size;
  const total = users + channels;
  const btn = document.getElementById('following-indicator');
  const cnt = document.getElementById('following-count');
  const lbl = document.getElementById('following-label');
  if (btn) btn.classList.toggle('has-following', total > 0);
  if (cnt) cnt.textContent = total;
  if (lbl) {
    if (users > 0 && channels > 0) lbl.textContent = `following (${users} user${users !== 1 ? 's' : ''}, ${channels} ch)`;
    else if (channels > 0) lbl.textContent = `channel${channels !== 1 ? 's' : ''} following`;
    else lbl.textContent = 'following';
  }
}

function updateFollowersIndicator() {
  const n = knownFollowers.size;
  const btn = document.getElementById('followers-indicator');
  const cnt = document.getElementById('followers-count');
  if (btn) btn.classList.toggle('has-followers', n > 0);
  if (cnt) cnt.textContent = n;
}

function renderFollowersModal() {
  const container = document.getElementById('followers-container');
  if (!container) return;
  if (knownFollowers.size === 0) {
    container.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text-muted);padding:8px 0">No followers yet. Someone needs to publish a follow list that includes you.</div>';
    return;
  }
  const entries = [...knownFollowers].map(pk => {
    const peer = peers.find(p => p.pubkey === pk);
    const post = posts.find(p => p.sender_pubkey === pk);
    const name = peer?.username || post?.sender_username || '(unknown)';
    const fp   = peer?.fingerprint || post?.sender_fingerprint || pk.slice(0, 24) + '…';
    const profileClick = `onclick="openProfile('${escHtml(pk)}');closeModal('followers-modal')"`;
    return `<div class="bl-user-row">
      <div class="bl-user-info">
        <div class="bl-user-name profile-link" ${profileClick} style="cursor:pointer">${escHtml(name)}</div>
        <div class="bl-user-fp">${escHtml(fp)}</div>
      </div>
    </div>`;
  }).join('');
  container.innerHTML = `<div class="bl-section"><div class="bl-section-body">${entries}</div></div>`;
}

function openFollowersModal() {
  renderFollowersModal();
  document.getElementById('followers-modal').classList.add('open');
}

function followPeer(pubkey, listId) {
  if (!listId) listId = getDefaultFollowListId();
  followlists[listId].pubkeys.add(pubkey);
  saveFollowlists();
  renderPeerList();
  renderFollowingFeed();
  updateProfileFollowBtn(pubkey);
  toast('User followed', 'success');
  // Notify the followed peer with a silent DM so their followers indicator
  // updates immediately, even if they're not online when we publish our follow list.
  if (window.agora?.request) {
    window.agora.request('send_dm', { recipient: pubkey, content: FOLLOW_SIGNAL }).catch(() => {});
  }
}

function unfollowPeer(pubkey, listId) {
  if (listId) {
    followlists[listId]?.pubkeys.delete(pubkey);
  } else {
    for (const list of Object.values(followlists)) list.pubkeys.delete(pubkey);
  }
  saveFollowlists();
  renderPeerList();
  renderFollowingFeed();
  renderFollowModal();
  updateProfileFollowBtn(pubkey);
  toast('User unfollowed', 'info');
}

let _followPickerTarget = null;

function confirmFollowPeer(pubkey) {
  const ownedLists = Object.entries(followlists).filter(([, l]) => l.owned);
  if (isFollowing(pubkey)) { unfollowPeer(pubkey); return; }
  if (ownedLists.length <= 1) {
    followPeer(pubkey, ownedLists[0]?.[0]);
  } else {
    showFollowPicker(pubkey);
  }
}

function showFollowPicker(pubkey) {
  _followPickerTarget = pubkey;
  const peer = peers.find(p => p.pubkey === pubkey);
  const post = posts.find(p => p.sender_pubkey === pubkey);
  const name = peer?.username || post?.sender_username || peer?.fingerprint || pubkey.slice(0, 12);
  document.getElementById('follow-picker-name').textContent = `Follow "${name}" — choose a list:`;
  const ownedLists = Object.entries(followlists).filter(([, l]) => l.owned);
  document.getElementById('follow-picker-lists').innerHTML = ownedLists.map(([id, list]) =>
    `<button class="block-picker-btn" onclick="performFollow('${escHtml(pubkey)}','${escHtml(id)}')">${escHtml(list.name)} <span style="opacity:.5;font-size:9px">${list.pubkeys.size} users</span></button>`
  ).join('') +
  `<button class="block-picker-btn block-picker-new" onclick="followPickerNewList('${escHtml(pubkey)}')">+ New list…</button>`;
  document.getElementById('follow-picker-modal').classList.add('open');
}

function performFollow(pubkey, listId) {
  closeModal('follow-picker-modal');
  followPeer(pubkey, listId);
}

function followPickerNewList(pubkey) {
  const name = prompt('New follow list name:');
  if (!name?.trim()) return;
  const id = newFollowListId();
  followlists[id] = { name: name.trim(), pubkeys: new Set(), owned: true };
  closeModal('follow-picker-modal');
  followPeer(pubkey, id);
}

// Toggle from peer list menu or chat header menu
function toggleFollowPeer(pubkey) {
  if (isFollowing(pubkey)) unfollowPeer(pubkey);
  else confirmFollowPeer(pubkey);
}

// Toggle from profile modal
function toggleFollowFromProfile() {
  if (!_profilePubkey) return;
  if (isFollowing(_profilePubkey)) unfollowPeer(_profilePubkey);
  else confirmFollowPeer(_profilePubkey);
  updateProfileFollowBtn(_profilePubkey);
}

function confirmBlockFromProfile() {
  if (!_profilePubkey) return;
  confirmBlockPeer(_profilePubkey);
  updateProfileFollowBtn(_profilePubkey);
}

function updateProfileFollowBtn(pubkey) {
  if (_profilePubkey !== pubkey) return;
  const followBtn = document.getElementById('profile-follow-btn');
  const blockBtn  = document.getElementById('profile-block-btn');
  if (!followBtn || !blockBtn) return;
  const following = isFollowing(pubkey);
  const blocked   = isBlocked(pubkey);
  followBtn.textContent = following ? 'Unfollow' : 'Follow';
  followBtn.classList.toggle('is-following', following);
  blockBtn.textContent = blocked ? 'Unblock' : 'Block';
  blockBtn.classList.toggle('is-blocked', blocked);
}

function openFollowModal() {
  renderFollowModal();
  document.getElementById('follow-modal').classList.add('open');
}

function renderFollowModal() {
  const container = document.getElementById('followlists-container');
  if (!container) return;
  const ownedLists = Object.entries(followlists).filter(([, l]) => l.owned);
  if (ownedLists.length === 0) {
    container.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text-muted);padding:8px 0">No follow lists yet. Follow a user to create one.</div>';
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
        <button class="btn-sm" onclick="unfollowPeer('${escHtml(pk)}','${escHtml(id)}')" title="Unfollow">Unfollow</button>
      </div>`;
    }).join('');
    const channelEntries = [...channels].map(ch =>
      `<div class="bl-user-row">
        <div class="bl-user-info">
          <div class="bl-user-name">#${escHtml(ch)}</div>
          <div class="bl-user-fp">channel</div>
        </div>
        <button class="btn-sm" onclick="removeChannelFromFollowlist('${escHtml(id)}','${escHtml(ch)}')" title="Unfollow channel">Unfollow</button>
      </div>`
    ).join('');
    const totalCount = list.pubkeys.size + channels.size;
    const countLabel = `${list.pubkeys.size} user${list.pubkeys.size !== 1 ? 's' : ''}${channels.size > 0 ? `, ${channels.size} channel${channels.size !== 1 ? 's' : ''}` : ''}`;
    return `<div class="bl-section">
      <div class="bl-section-header">
        <span class="bl-section-name">${escHtml(list.name)}</span>
        <span class="bl-section-count">${countLabel}</span>
        <div class="bl-section-actions">
          <button class="btn-sm" onclick="promptAddChannelToFollowlist('${escHtml(id)}')" title="Follow a channel">+ Channel</button>
          <button class="btn-sm" onclick="openPublishFollowlistPicker('${escHtml(id)}')" title="Publish this list">📢 Publish</button>
          <button class="btn-danger" onclick="deleteFollowlist('${escHtml(id)}')" title="Delete list">✕</button>
        </div>
      </div>
      <div class="bl-section-body">
        ${userEntries}${channelEntries}${totalCount === 0 ? '<div class="bl-empty">No users or channels in this list</div>' : ''}
      </div>
    </div>`;
  }).join('');
}

function createNewFollowlist() {
  const name = prompt('New follow list name:');
  if (!name?.trim()) return;
  const id = newFollowListId();
  followlists[id] = { name: name.trim(), pubkeys: new Set(), channels: new Set(), owned: true };
  saveFollowlists();
  renderFollowModal();
  toast(`Created list "${name.trim()}"`, 'success');
}

function addChannelToFollowlist(listId, channelName) {
  const list = followlists[listId];
  if (!list || !list.owned) return;
  if (!list.channels) list.channels = new Set();
  list.channels.add(channelName);
  saveFollowlists();
  renderFollowModal();
  renderFollowingFeed();
  toast(`#${channelName} added to follow list`, 'success');
}

function removeChannelFromFollowlist(listId, channelName) {
  const list = followlists[listId];
  if (!list || !list.owned) return;
  list.channels && list.channels.delete(channelName);
  saveFollowlists();
  renderFollowModal();
  renderFollowingFeed();
}

function promptAddChannelToFollowlist(listId) {
  const known = discoverChannels();
  const list = followlists[listId];
  if (!list) return;
  const available = known.filter(ch => !(list.channels && list.channels.has(ch)));
  let channelName;
  if (available.length > 0) {
    channelName = prompt('Channel to follow (known: ' + available.join(', ') + '):');
  } else {
    channelName = prompt('Channel name to follow:');
  }
  if (!channelName?.trim()) return;
  const name = channelName.trim().replace(/^#/, '');
  if (!CHANNEL_NAME_RE.test(name)) { toast('Invalid channel name', 'error'); return; }
  addChannelToFollowlist(listId, name);
}

function addChannelToBlocklist(listId, channelName) {
  const list = blocklists[listId];
  if (!list || !list.owned) return;
  if (!list.channels) list.channels = new Set();
  list.channels.add(channelName);
  saveBlocklists();
  renderBlockedModal();
  if (activeChannel === channelName) setActiveChannel(null);
  else renderFeed();
  toast(`#${channelName} added to blocklist`, 'success');
}

function removeChannelFromBlocklist(listId, channelName) {
  const list = blocklists[listId];
  if (!list || !list.owned) return;
  list.channels && list.channels.delete(channelName);
  saveBlocklists();
  renderBlockedModal();
  renderFeedChannelStrip();
}

function promptAddChannelToBlocklist(listId) {
  const known = discoverChannels();
  const list = blocklists[listId];
  if (!list) return;
  const available = known.filter(ch => !(list.channels && list.channels.has(ch)));
  let channelName;
  if (available.length > 0) {
    channelName = prompt('Channel to block (known: ' + available.join(', ') + '):');
  } else {
    channelName = prompt('Channel name to block:');
  }
  if (!channelName?.trim()) return;
  const name = channelName.trim().replace(/^#/, '');
  if (!CHANNEL_NAME_RE.test(name)) { toast('Invalid channel name', 'error'); return; }
  addChannelToBlocklist(listId, name);
}

function deleteFollowlist(id) {
  const list = followlists[id];
  if (!list) return;
  if (!confirm(`Delete follow list "${list.name}"?`)) return;
  delete followlists[id];
  saveFollowlists();
  renderPeerList();
  renderFollowingFeed();
  renderFollowModal();
  toast('Follow list deleted', 'info');
}

async function publishFollowlist(listId, silent = false, targetChannel = null) {
  const list = followlists[listId];
  if (!list || !list.owned) { if (!silent) toast('List not found', 'error'); return; }
  if (list.pubkeys.size === 0 && (!list.channels || list.channels.size === 0)) { if (!silent) toast('No followed users or channels to publish', 'error'); return; }
  const names = {};
  for (const pk of list.pubkeys) {
    const peer = peers.find(p => p.pubkey === pk);
    const post = posts.find(p => p.sender_pubkey === pk);
    names[pk] = peer?.username || post?.sender_username || peer?.fingerprint || post?.sender_fingerprint || '';
  }
  const payload = JSON.stringify({ list_name: list.name, pubkeys: [...list.pubkeys], names, channels: [...(list.channels || [])] });
  let content = FOLLOWLIST_MAGIC + payload;
  if (targetChannel) content = encodeChannelPost(targetChannel, content);
  const resp = await window.agora?.request('broadcast', { content });
  if (resp?.error) { if (!silent) toast('Failed to publish: ' + resp.error, 'error'); return; }
  if (!silent) {
    closeModal('follow-modal');
    const dest = targetChannel ? `to #${targetChannel}` : 'to the network';
    toast(`Follow list "${list.name}" published ${dest}`, 'success');
    await refreshPosts();
  }
}

function openPublishFollowlistPicker(listId) {
  _pendingPublishListId = listId;
  _pendingPublishListType = 'follow';
  openPublishChannelPicker();
}

function openPublishBlocklistPicker(listId) {
  _pendingPublishListId = listId;
  _pendingPublishListType = 'block';
  openPublishChannelPicker();
}

let _pendingPublishListId = null;
let _pendingPublishListType = null; // 'follow' | 'block'

function openPublishChannelPicker() {
  const modal = document.getElementById('publish-channel-picker-modal');
  if (!modal) return;
  const list = document.getElementById('pub-ch-picker-list');
  const channels = discoverChannels();
  let html = `<button class="block-picker-btn pub-ch-global-btn" onclick="confirmPublishList(null)">📢 Global (no channel)</button>`;
  for (const ch of channels) {
    html += `<button class="block-picker-btn" onclick="confirmPublishList('${escHtml(ch)}')">#${escHtml(ch)}</button>`;
  }
  if (channels.length === 0) {
    html += `<div style="font-family:var(--mono);font-size:11px;color:var(--text-muted);padding:4px 0">No channels found. Posts will be published globally.</div>`;
  }
  list.innerHTML = html;
  modal.classList.add('open');
}

async function confirmPublishList(channelName) {
  closeModal('publish-channel-picker-modal');
  if (_pendingPublishListType === 'follow') {
    await publishFollowlist(_pendingPublishListId, false, channelName);
  } else if (_pendingPublishListType === 'block') {
    await publishBlocklist(_pendingPublishListId, false, channelName);
  }
  _pendingPublishListId = null;
  _pendingPublishListType = null;
}

function parseFollowlistPost(content) {
  if (!content.startsWith(FOLLOWLIST_MAGIC)) return null;
  try { return JSON.parse(content.slice(FOLLOWLIST_MAGIC.length)); } catch { return null; }
}

/**
 * Render the "Following" tab feed — posts from followed users and channels.
 *
 * A post is included if:
 *   - The sender is in any owned follow list, OR
 *   - The post was sent to a channel that is in any owned follow list.
 *
 * Blocklist/follow list broadcast posts are excluded (they're not content).
 * Blocked and blocking-us senders are also excluded.
 * Posts are sorted newest-first.
 */
function renderFollowingFeed() {
  const list = document.getElementById('following-feed-list');
  if (!list) return;
  const followed = allFollowedPubkeys();
  const followedChannels = allFollowedChannels();
  if (followed.size === 0 && followedChannels.size === 0) {
    list.innerHTML = '<div class="feed-empty">You are not following anyone yet.<br>Follow users from the Peers tab or their profile.</div>';
    return;
  }
  try {
    const arr = Array.isArray(posts) ? posts.filter(p => {
      if (isBlocked(p.sender_pubkey) || blockedByPubkeys.has(p.sender_pubkey)) return false;
      const _ic = (() => { const _c = parseChannelPost(p.content); return _c ? _c.text : p.content; })();
      if (parseFollowlistPost(_ic) || parseBlocklistPost(_ic)) return false; // skip list broadcast posts
      const ch = parseChannelPost(p.content);
      if (ch && followedChannels.has(ch.channel)) return true; // post in followed channel
      return followed.has(p.sender_pubkey); // post from followed user
    }) : [];
    if (arr.length === 0) {
      list.innerHTML = '<div class="feed-empty">No posts from people or channels you follow yet.</div>';
      return;
    }
    const sorted = [...arr].sort((a, b) =>
      (new Date(b?.timestamp || 0).getTime() || 0) - (new Date(a?.timestamp || 0).getTime() || 0)
    );
    list.innerHTML = sorted.map(p => {
      if (!p || typeof p !== 'object') return '';
      const postId      = String(p.post_id || '');
      const fingerprint = String(p.sender_fingerprint || '');
      const username    = typeof p.sender_username === 'string' ? p.sender_username : '';
      const name        = username || fingerprint || 'unknown';
      const rawContent  = String(p.content ?? '');
      const chParsed    = parseChannelPost(rawContent);
      const content     = chParsed ? chParsed.text : rawContent;
      const likeCount   = Number.isFinite(p.like_count) ? p.like_count : 0;
      const isOwn       = !!p.is_own;
      const liked       = likedPostIds.has(postId);
      const shortId     = postId ? postId.slice(0, 8) : '--------';
      if (p.sender_pubkey && p.sender_avatar) peerAvatars[p.sender_pubkey] = p.sender_avatar;
      let timeStr = '';
      try { timeStr = formatTime(p.timestamp); } catch {}
      const profileClick = p.sender_pubkey ? `onclick="openProfile('${escHtml(p.sender_pubkey)}')"` : '';
      const channelTag = chParsed ? `<span class="post-channel-tag">#${escHtml(chParsed.channel)}</span>` : '';
      const imageHtml = p.image ? `<div class="post-image"><img src="${escHtml(p.image)}" alt="attached image" onclick="openImageViewer(this.src)"/></div>` : '';
      const embedHtml = p.embed_url ? renderEmbedHtml(p.embed_url) : '';
      return `<div class="post-card${isOwn ? ' own-post' : ''}" id="fw-post-${escHtml(postId)}">
        <div class="post-header">
          <div class="post-avatar${isOwn ? ' own' : ''}">${escHtml((name || '?')[0].toUpperCase())}</div>
          <div class="post-author">
            <div class="post-author-name profile-link" ${profileClick} title="View profile">${escHtml(name)}${channelTag}</div>
            <div class="post-author-fp">${escHtml(fingerprint)}</div>
          </div>
          <div class="post-time">${escHtml(timeStr)}</div>
        </div>
        ${content ? `<div class="post-content">${escHtml(content)}</div>` : ''}
        ${imageHtml}
        ${embedHtml}
        <div class="post-footer">
          <button class="like-btn${liked ? ' liked' : ''}" onclick="likePost('${escHtml(postId)}')" title="Like">
            <span class="heart">❤</span> <span class="like-count">${likeCount}</span>
          </button>
          <button class="comment-btn" onclick="openPostComments('${escHtml(postId)}')" title="Comments">
            💬 <span>${Number.isFinite(p.comment_count) ? p.comment_count : 0}</span>
          </button>
          <span class="post-id-tag">${escHtml(shortId)}</span>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="feed-empty">Feed render error:<br/>' + escHtml(String(e?.message || e)) + '</div>';
  }
}

function loadSubscriptions() {
  try {
    const saved = localStorage.getItem('agora_blocklist_subs');
    if (saved) {
      const arr = JSON.parse(saved);
      // Migrate old pubkey-only entries to "pubkey::listname" format
      subscribedToBlocklists = new Set(arr.map(item =>
        item.includes('::') ? item : subKey(item, DEFAULT_LIST_NAME)
      ));
    }
  } catch {}
}

function saveSubscriptions() {
  try { localStorage.setItem('agora_blocklist_subs', JSON.stringify([...subscribedToBlocklists])); } catch {}
}

function loadFollowlistSubs() {
  try {
    const saved = localStorage.getItem('agora_followlist_subs');
    if (saved) subscribedToFollowlists = new Set(JSON.parse(saved));
  } catch {}
}

function saveFollowlistSubs() {
  try { localStorage.setItem('agora_followlist_subs', JSON.stringify([...subscribedToFollowlists])); } catch {}
}

function loadKnownFollowers() {
  try {
    const saved = localStorage.getItem('agora_known_followers');
    if (saved) knownFollowers = new Set(JSON.parse(saved));
  } catch {}
}

function saveKnownFollowers() {
  try { localStorage.setItem('agora_known_followers', JSON.stringify([...knownFollowers])); } catch {}
}

function loadUnreadDms() {
  try {
    const saved = localStorage.getItem('agora_unread_dms');
    if (saved) unreadDms = new Set(JSON.parse(saved));
  } catch {}
}

function saveUnreadDms() {
  try { localStorage.setItem('agora_unread_dms', JSON.stringify([...unreadDms])); } catch {}
}

/**
 * Scan a list of posts for published follow lists that contain our pubkey.
 * Called on every refreshPosts() and on every incoming broadcast event so we
 * detect new followers in real time.  Deduplicates via `knownFollowers` — once
 * a pubkey is in that set we never notify again (even across reloads, because
 * knownFollowers is persisted to localStorage).
 */
function checkFollowNotifications(postList) {
  if (!myIdentity?.pubkey) return;
  let newCount = 0;
  let lastName = '';
  for (const p of postList) {
    if (!p?.content || p.sender_pubkey === myIdentity.pubkey) continue;
    const fl = parseFollowlistPost(p.content);
    if (!fl || !Array.isArray(fl.pubkeys)) continue;
    if (fl.pubkeys.includes(myIdentity.pubkey) && !knownFollowers.has(p.sender_pubkey)) {
      knownFollowers.add(p.sender_pubkey);
      newCount++;
      lastName = p.sender_username || p.sender_fingerprint || p.sender_pubkey.slice(0, 8);
    }
  }
  if (newCount > 0) {
    saveKnownFollowers();
    updateFollowersIndicator();
    const msg = newCount === 1 ? `${lastName} followed you` : `${newCount} new users followed you`;
    pushNotification({ type: 'follow', text: `<span class="notif-name">${escHtml(msg)}</span>`, time: new Date().toISOString() });
    toast(msg, 'success');
  }
}
