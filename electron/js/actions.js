// ── Actions ────────────────────────────────────────────────────────────────────
/**
 * selectPeer — open a DM conversation with the given peer.
 *
 * Steps:
 *   1. Update `activePeer` and clear any pending DM image attachment.
 *   2. Show the chat pane (hide the "no peer selected" placeholder).
 *   3. Populate the chat header with the peer's name, avatar, and fingerprint.
 *   4. Clear the unread badge and re-sort the peer list.
 *   5. Render all in-memory messages for this peer.
 *   6. Load the persisted DM history from the daemon (last 500 messages).
 *   7. Focus the message input (unless this user has blocked us).
 */
function selectPeer(pubkey, event) {
  activePeer = pubkey;
  clearDmImage();
  const peer = peers.find(p => p.pubkey === pubkey);
  if (!peer) return;
  document.querySelectorAll('.peer-item').forEach(el => el.classList.remove('active'));
  event?.currentTarget?.classList.add('active');

  showView('chat');
  document.getElementById('no-peer').style.display = 'none';
  document.getElementById('chat-header').style.display = 'flex';
  document.getElementById('messages').style.display = 'flex';

  const name = peer.username || '(unnamed)';
  const chatAvatarEl = document.getElementById('chat-avatar');
  chatAvatarEl.innerHTML = avatarContent(peer.pubkey, name);
  if (peerAvatars[peer.pubkey]) {
    chatAvatarEl.style.cursor = 'pointer';
    chatAvatarEl.title = 'View profile picture';
    chatAvatarEl.onclick = () => openPeerAvatarViewer(peer.pubkey);
  } else {
    chatAvatarEl.style.cursor = '';
    chatAvatarEl.title = '';
    chatAvatarEl.onclick = null;
  }
  const chatNameEl = document.getElementById('chat-target-name');
  chatNameEl.textContent = name;
  chatNameEl.classList.add('profile-link');
  chatNameEl.title = 'View profile';
  chatNameEl.onclick = () => openProfile(peer.pubkey);
  document.getElementById('chat-target-fp').textContent = peer.fingerprint + ' · ' + peer.pubkey.slice(0,16) + '…';
  // Clear unread badge
  if (unreadDms.has(pubkey)) {
    unreadDms.delete(pubkey);
    saveUnreadDms();
    renderPeerList();
  }
  updateChatBlockBtn();
  updateInputBarBlockedBy();
  renderMessages();
  loadDmHistory(pubkey).catch(e => console.error('[dm] history load failed:', e));
  if (!blockedByPubkeys.has(pubkey)) document.getElementById('msg-input').focus();
}

/**
 * Load DM history for a peer from the daemon's persistent JSONL log.
 *
 * The daemon stores every sent/received DM to dms.jsonl.  This function fetches
 * up to 500 records, filters out protocol-internal messages (block signals, group
 * protocol DMs), then merges with any live session messages already in memory to
 * avoid duplicates.
 *
 * Deduplication key: timestamp + content string.  Not collision-proof but
 * sufficient for practical use (two identical messages sent at exactly the same
 * millisecond to the same peer would be collapsed — this is acceptable).
 *
 * After merging, messages are sorted chronologically before re-rendering.
 */
async function loadDmHistory(pubkey) {
  if (!window.agora?.request) return;
  const resp = await window.agora.request('dm_history', { peer_pubkey: pubkey, limit: 500 });
  if (resp?.error) { console.error('[dm] history error:', resp.error); return; }
  const records = Array.isArray(resp?.result) ? resp.result : [];
  // Drop any previously-loaded history for this peer so we don't double-render
  // on reselect, but keep live messages that arrived during the session.
  const loadedIds = new Set(messages.filter(m => m.loaded).map(m => m._key));
  messages = messages.filter(m => !m.loaded || !loadedIds.has(m._key));
  for (const r of records) {
    // Filter out block signal and group protocol messages from DM history display
    const rc = String(r.content || '');
    if (rc === BLOCK_SIGNAL) continue;
    if (rc.startsWith(GROUP_MSG_MAGIC) || rc.startsWith(GROUP_SYS_MAGIC)) continue;
    const own = r.direction === 'out';
    const msg = {
      kind: 'dm',
      own,
      loaded: true,
      _key: (r.timestamp || '') + '|' + (r.content || ''),
      recipient: own ? pubkey : undefined,
      sender_pubkey: own ? (myIdentity?.pubkey || '') : pubkey,
      sender_fingerprint: r.peer_fingerprint || '',
      sender_username: r.peer_username || undefined,
      content: String(r.content || ''),
      image: r.image || null,
      timestamp: r.timestamp || new Date().toISOString(),
    };
    // Avoid duplicating a message that already exists in the live array.
    const dup = messages.some(m => m.content === msg.content && m.timestamp === msg.timestamp &&
      ((m.own && own && m.recipient === pubkey) || (!m.own && !own && m.sender_pubkey === pubkey)));
    if (!dup) messages.push(msg);
  }
  messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  if (activePeer === pubkey) renderMessages();
}

async function sendMessage() {
  if (!activePeer) return;
  if (isBlocked(activePeer)) { toast('Cannot send to a blocked user', 'error'); return; }
  if (blockedByPubkeys.has(activePeer)) { toast('This user has blocked you', 'error'); return; }
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  const image = pendingDmImage;
  if (!content && !image) return;
  input.value = '';
  input.style.height = '';
  clearDmImage();

  const params = { recipient: activePeer, content };
  if (image) params.image = image;
  const resp = await window.agora?.request('send_dm', params);
  if (resp?.error) { toast('Send failed: ' + resp.error, 'error'); return; }

  const msg = { kind:'dm', own:true, recipient:activePeer, sender_pubkey:myIdentity?.pubkey||'', sender_fingerprint:myIdentity?.fingerprint||'', sender_username:myIdentity?.username, content, image: image || undefined, timestamp:new Date().toISOString() };
  messages.push(msg);
  appendMessage(msg);
}

/**
 * Publish a broadcast post.
 *
 * If a channel is active, the content is prefixed with the channel magic string
 * before being sent to the daemon so receiving peers can route it to the correct
 * channel without any daemon-level awareness of channels.
 *
 * Images and embed URLs are passed as separate fields in the RPC payload.
 * The embed URL was auto-detected by detectEmbedUrl() as the user typed.
 *
 * After posting, the composer state (text, image, embed preview) is fully cleared
 * and the feed is refreshed to show the new post.
 */
async function submitPost() {
  const input = document.getElementById('post-input');
  const content = input.value.trim();
  if (!content && !pendingPostImage) return;
  input.value = '';
  input.style.height = '';
  const image = pendingPostImage;
  const embedUrl = pendingEmbedUrl;
  clearPostImage();
  pendingEmbedUrl = null;
  embedUserCleared = false;
  updateEmbedPreview(null);

  // Wrap in channel encoding if we're currently in a channel view.
  const encodedContent = activeChannel ? encodeChannelPost(activeChannel, content) : content;
  const params = { content: encodedContent };
  if (image) params.image = image;
  if (embedUrl) params.embed_url = embedUrl;
  const resp = await window.agora?.request('broadcast', params);
  if (resp?.error) { toast('Post failed: ' + resp.error, 'error'); return; }
  toast(activeChannel ? `Posted to #${activeChannel}!` : 'Posted! Propagating for 24h…', 'success');
  await refreshPosts();
}
