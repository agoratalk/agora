// ── Profile modal ──────────────────────────────────────────────────────────────
/**
 * Open the profile modal for any pubkey — our own or a peer's.
 *
 * Own profile: shows editable bio textarea + save button.
 * Peer profile: shows read-only bio, Follow/Unfollow and Block/Unblock buttons.
 *
 * The modal stores the viewed pubkey in `_profilePubkey` so that follow/block
 * button callbacks can use it without threading the pubkey through every call.
 */
function openProfile(pubkey) {
  if (!pubkey) return;
  _profilePubkey = pubkey;
  const isOwn = pubkey === myIdentity?.pubkey;
  const peer = peers.find(p => p.pubkey === pubkey);
  const name = isOwn
    ? (myIdentity?.username || myIdentity?.fingerprint || 'You')
    : (peer?.username || peer?.fingerprint || pubkey.slice(0, 16) + '…');
  const fp = isOwn ? myIdentity?.fingerprint : (peer?.fingerprint || pubkey.slice(0, 24) + '…');
  const bio = peerBios[pubkey] || null;

  // Avatar
  const avatarEl = document.getElementById('profile-modal-avatar');
  if (peerAvatars[pubkey]) {
    avatarEl.innerHTML = `<img src="${escHtml(peerAvatars[pubkey])}" alt=""/>`;
  } else {
    avatarEl.innerHTML = escHtml((name || '?')[0].toUpperCase());
  }

  document.getElementById('profile-modal-name').textContent = name;
  document.getElementById('profile-modal-fp').textContent = fp || '';
  document.getElementById('profile-modal-own-badge').style.display = isOwn ? '' : 'none';

  const bioView = document.getElementById('profile-bio-view');
  const bioEditWrap = document.getElementById('profile-bio-edit-wrap');
  const saveBtn = document.getElementById('profile-save-btn');

  if (isOwn) {
    bioView.style.display = 'none';
    bioEditWrap.style.display = '';
    saveBtn.style.display = '';
    const ta = document.getElementById('profile-bio-textarea');
    ta.value = bio || '';
    onBioInput();
  } else {
    bioView.style.display = '';
    bioEditWrap.style.display = 'none';
    saveBtn.style.display = 'none';
    if (bio) {
      bioView.innerHTML = escHtml(bio);
      bioView.classList.remove('profile-bio-empty');
    } else {
      bioView.innerHTML = '<span class="profile-bio-empty">No bio yet.</span>';
    }
  }

  // Show Follow/Block action row for other users
  const actionRow = document.getElementById('profile-action-row');
  if (actionRow) actionRow.style.display = isOwn ? 'none' : '';
  if (!isOwn) updateProfileFollowBtn(pubkey);

  document.getElementById('profile-modal').classList.add('open');
}

function onBioInput() {
  const ta = document.getElementById('profile-bio-textarea');
  const counter = document.getElementById('profile-bio-counter');
  if (!ta || !counter) return;
  const len = ta.value.length;
  counter.textContent = `${len} / 500`;
  counter.classList.toggle('over', len > 500);
}

async function saveBio() {
  const ta = document.getElementById('profile-bio-textarea');
  if (!ta) return;
  const bio = ta.value.trim().slice(0, 500) || null;
  const resp = await window.agora?.request('set_bio', { bio });
  if (resp?.error) { toast('Failed to save bio: ' + resp.error, 'error'); return; }
  if (myIdentity) {
    myIdentity.bio = bio;
    if (bio) peerBios[myIdentity.pubkey] = bio;
    else delete peerBios[myIdentity.pubkey];
  }
  closeModal('profile-modal');
  toast('Bio saved', 'success');
}

/**
 * Fetch all broadcast posts from the daemon and refresh both feeds.
 *
 * After updating the posts array this function:
 *   1. Re-renders the public feed and following feed.
 *   2. Checks for new followers in published follow list posts.
 *   3. Auto-imports the latest version of any blocklists we're subscribed to.
 *   4. Auto-imports the latest version of any follow lists we're subscribed to.
 *
 * The subscription auto-import logic finds the most recent post from each
 * subscribed source that matches the expected list name, then imports it
 * silently without showing a toast.
 */
async function refreshPosts() {
  const list = document.getElementById('feed-list');
  try {
    if (!window.agora?.request) {
      console.warn('[feed] no IPC bridge');
      if (list) list.innerHTML = '<div class="feed-empty">Not connected to daemon.</div>';
      return;
    }
    const resp = await window.agora.request('posts', {});
    if (resp?.error) {
      console.error('[feed] daemon error:', resp.error);
      if (list) list.innerHTML = '<div class="feed-empty">Daemon error:<br/>' + escHtml(String(resp.error)) + '</div>';
      return;
    }
    posts = Array.isArray(resp?.result) ? resp.result : [];
    renderFeed();
    renderFollowingFeed();
    checkFollowNotifications(posts);
    // Auto-import latest blocklist from any peers we're subscribed to
    for (const key of subscribedToBlocklists) {
      const sepIdx = key.indexOf('::');
      if (sepIdx < 0) continue;
      const pubkey = key.slice(0, sepIdx);
      const listName = key.slice(sepIdx + 2);
      const latest = posts
        .filter(p => p.sender_pubkey === pubkey)
        .map(p => ({ p, bl: parseBlocklistPost(p.content) }))
        .filter(x => x.bl && (x.bl.list_name || DEFAULT_LIST_NAME) === listName)
        .sort((a, b) => new Date(b.p.timestamp) - new Date(a.p.timestamp))[0];
      if (latest) {
        const importId = getOrCreateOwnedList('Imported from ' + (latest.p.sender_username || pubkey.slice(0, 8)));
        importBlocklistPubkeys(latest.bl.pubkeys, importId, true);
      }
    }
    // Auto-import latest follow list from any peers we're subscribed to
    for (const key of subscribedToFollowlists) {
      const sepIdx = key.indexOf('::');
      if (sepIdx < 0) continue;
      const pubkey = key.slice(0, sepIdx);
      const listName = key.slice(sepIdx + 2);
      const latest = posts
        .filter(p => p.sender_pubkey === pubkey)
        .map(p => ({ p, fl: parseFollowlistPost(p.content) }))
        .filter(x => x.fl && (x.fl.list_name || DEFAULT_FOLLOW_LIST) === listName)
        .sort((a, b) => new Date(b.p.timestamp) - new Date(a.p.timestamp))[0];
      if (latest) {
        const listId = getOrCreateFollowList('Imported from ' + (latest.p.sender_username || pubkey.slice(0, 8)));
        importFollowlistPubkeys(latest.fl.pubkeys, listId, true);
      }
    }
  } catch (e) {
    console.error('[feed] refreshPosts crashed:', e);
    if (list) list.innerHTML = '<div class="feed-empty">Failed to load feed:<br/>' + escHtml(String(e?.message || e)) + '</div>';
  }
}
