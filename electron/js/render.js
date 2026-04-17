// ── Avatar helpers ─────────────────────────────────────────────────────────────
/**
 * Avatars are stored as base64-encoded data URLs in `peerAvatars[pubkey]`.
 * They are transmitted by the daemon as part of peer metadata and broadcast/DM
 * event payloads, then cached locally in this map.
 *
 * avatarContent() is used throughout the rendering code to generate the inner
 * HTML for any avatar container element — either an <img> tag if we have a
 * data URL, or a capital initial as a fallback.
 */

// Returns inner HTML for an avatar container: either an <img> or a text initial.
function avatarContent(pubkey, name) {
  const src = pubkey && peerAvatars[pubkey];
  if (src) return `<img src="${escHtml(src)}" alt=""/>`;
  return escHtml((name || '?')[0].toUpperCase());
}

// Update the identity-card avatar in the sidebar
function renderIdentityAvatar() {
  const el = document.getElementById('identity-avatar');
  if (!el) return;
  const name = myIdentity?.username || myIdentity?.fingerprint || '?';
  const src = myIdentity?.pubkey && peerAvatars[myIdentity.pubkey];
  const initial = name[0].toUpperCase();
  const overlay = '<div class="avatar-overlay">✎</div>';
  if (src) {
    el.innerHTML = `<img src="${escHtml(src)}" alt=""/>${overlay}`;
  } else {
    el.innerHTML = `<span id="my-avatar-initial">${escHtml(initial)}</span>${overlay}`;
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────────
/**
 * renderPeerList — rebuild the left sidebar peer list from the current state.
 *
 * Filtering pipeline:
 *   1. Skip blocked peers and peers who blocked us.
 *   2. If in the 'following' tab, keep only followed peers.
 *   3. Apply the live search query (username, fingerprint, or pubkey prefix).
 *
 * Sort order (when no search query is active):
 *   Rank 0: followed AND has unread DMs  (highest priority)
 *   Rank 1: followed OR has unread DMs
 *   Rank 2: neither
 *
 * If in the 'groups' tab this function delegates to renderGroupList() instead
 * because the groups view reuses the same DOM element for its list.
 */
function renderPeerList() {
  if (activeTab === 'groups') { renderGroupList(); return; }
  const list = document.getElementById('peer-list');

  // Base filter: not blocked
  let visible = peers.filter(p => !isBlocked(p.pubkey) && !blockedByPubkeys.has(p.pubkey));
  if (activeTab === 'following') visible = visible.filter(p => isFollowing(p.pubkey));

  // Search filter
  const query = (document.getElementById('peer-search')?.value || '').trim().toLowerCase();
  if (query) {
    visible = visible.filter(p =>
      (p.username || '').toLowerCase().includes(query) ||
      (p.fingerprint || '').toLowerCase().includes(query) ||
      (p.pubkey || '').toLowerCase().includes(query)
    );
  }

  document.getElementById('peer-count') && (document.getElementById('peer-count').textContent = visible.length);

  if (visible.length === 0) {
    list.innerHTML = query
      ? `<div class="peer-empty">No peers match "${escHtml(query)}"</div>`
      : activeTab === 'following'
        ? `<div class="peer-empty">No followed peers online.<br>Follow users from the Feed tab.</div>`
        : `<div class="peer-empty">${t('no_peers')}</div>`;
    return;
  }

  // Sort: followed+unread → followed → unread → rest (stable within each group)
  if (!query) {
    visible = [...visible].sort((a, b) => {
      const af = isFollowing(a.pubkey), bf = isFollowing(b.pubkey);
      const au = unreadDms.has(a.pubkey), bu = unreadDms.has(b.pubkey);
      const rank = p => (isFollowing(p.pubkey) ? 0 : 2) + (unreadDms.has(p.pubkey) ? 0 : 1);
      return rank(a) - rank(b);
    });
  }

  list.innerHTML = visible.map(p => {
    const name = p.username || '(unnamed)';
    const active = activePeer === p.pubkey ? ' active' : '';
    const hasAvatar = !!peerAvatars[p.pubkey];
    const avatarClick = hasAvatar ? ` onclick="event.stopPropagation();openPeerAvatarViewer('${escHtml(p.pubkey)}')" style="cursor:pointer" title="View profile picture"` : '';
    const following = isFollowing(p.pubkey);
    const unread = unreadDms.has(p.pubkey);
    return `<div class="peer-item${active}" onclick="selectPeer('${escHtml(p.pubkey)}', event)">
      <div class="peer-avatar"${avatarClick}>${avatarContent(p.pubkey, p.username || p.fingerprint)}</div>
      <div class="peer-info">
        <div class="peer-name profile-link" onclick="event.stopPropagation();openProfile('${escHtml(p.pubkey)}')" title="View profile">${escHtml(name)}</div>
        <div class="peer-fp">${escHtml(p.fingerprint)}</div>
        <div class="peer-via">${escHtml((p.discovery||'').toLowerCase())}</div>
      </div>
      ${unread ? '<div class="peer-unread-dot" title="Unread messages"></div>' : ''}
    </div>`;
  }).join('');
}

// ── Embed helpers ─────────────────────────────────────────────────────────────
/**
 * Media embed support: when a post contains a YouTube, Vimeo, Spotify, Twitter/X,
 * or SoundCloud URL, a rich embed widget is shown below the post text.
 *
 * detectEmbedUrl() scans post text as it's typed in the composer and updates the
 * embed preview bar in real time.  The matched URL is stored as pendingEmbedUrl
 * and sent to the daemon's `broadcast` RPC as the `embed_url` field.
 *
 * renderEmbedHtml() produces the iframe/link HTML for a given URL.  It runs on
 * the receiving side (not just the sender) so all clients display embeds.
 *
 * The embedUserCleared flag is set when the user manually dismisses the embed
 * preview.  Once set, detectEmbedUrl() stops re-detecting until the user clears
 * the draft and starts a new post.
 */

/** Return the first embedable URL found in `text`, or null. */
function detectEmbedUrl(text) {
  const patterns = [
    /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:[^\s&]*&)*v=|youtu\.be\/)([a-zA-Z0-9_-]{11})[^\s]*/i,
    /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/\w+\/status\/\d+[^\s]*/i,
    /https?:\/\/open\.spotify\.com\/(?:track|album|playlist|episode)\/[a-zA-Z0-9]+[^\s]*/i,
    /https?:\/\/(?:www\.)?soundcloud\.com\/\S+/i,
    /https?:\/\/(?:www\.)?vimeo\.com\/\d+\S*/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].replace(/[.,;!?)\]]+$/, ''); // strip trailing punctuation
  }
  return null;
}

function youtubeVideoId(url) {
  const m = url.match(/(?:youtube\.com\/watch\?(?:[^&\s]*&)*v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  return m ? m[1] : null;
}

function spotifyEmbedSrc(url) {
  const m = url.match(/open\.spotify\.com\/(track|album|playlist|episode)\/([a-zA-Z0-9]+)/i);
  return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}?utm_source=generator` : null;
}

function vimeoVideoId(url) {
  const m = url.match(/vimeo\.com\/(\d+)/i);
  return m ? m[1] : null;
}

/** Render an embed widget for the given URL, or '' if unsupported. */
function renderEmbedHtml(embedUrl) {
  if (!embedUrl) return '';
  const safe = escHtml(embedUrl);

  const ytId = youtubeVideoId(embedUrl);
  if (ytId) {
    return `<div class="embed-container embed-yt"><iframe src="https://www.youtube.com/embed/${ytId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
  }

  const vmId = vimeoVideoId(embedUrl);
  if (vmId) {
    return `<div class="embed-container embed-yt"><iframe src="https://player.vimeo.com/video/${vmId}?badge=0&autopause=0" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
  }

  const spSrc = spotifyEmbedSrc(embedUrl);
  if (spSrc) {
    return `<div class="embed-container embed-spotify"><iframe src="${spSrc}" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe></div>`;
  }

  if (/(?:twitter\.com|x\.com)\/\w+\/status\/\d+/i.test(embedUrl)) {
    const domain = /x\.com/i.test(embedUrl) ? 'x.com' : 'twitter.com';
    return `<div class="embed-container"><a href="${safe}" target="_blank" rel="noopener" class="embed-link-card"><span class="embed-link-icon">𝕏</span><span class="embed-link-text">${safe}</span><span class="embed-link-domain">${escHtml(domain)}</span></a></div>`;
  }

  if (/soundcloud\.com\//i.test(embedUrl)) {
    const scSrc = `https://w.soundcloud.com/player/?url=${encodeURIComponent(embedUrl)}&color=%234fd6be&auto_play=false&hide_related=false&show_comments=false&show_user=true&show_reposts=false&show_teaser=false`;
    return `<div class="embed-container embed-soundcloud"><iframe src="${scSrc}" frameborder="0" allow="autoplay" loading="lazy"></iframe></div>`;
  }

  return '';
}

function updateEmbedPreview(url) {
  const bar = document.getElementById('embed-preview-bar');
  const label = document.getElementById('embed-preview-url');
  if (!bar || !label) return;
  if (!url) { bar.style.display = 'none'; label.textContent = ''; return; }
  label.textContent = url;
  bar.style.display = 'block';
}

function clearEmbedUrl() {
  pendingEmbedUrl = null;
  embedUserCleared = true;
  updateEmbedPreview(null);
}

function onPostInputChange() {
  if (!embedUserCleared) {
    const url = detectEmbedUrl(document.getElementById('post-input')?.value || '');
    pendingEmbedUrl = url;
    updateEmbedPreview(url);
  }
}

/**
 * renderFeed — rebuild the main broadcast post list from `posts`.
 *
 * Filtering:
 *   - Skip blocked and blocking-us pubkeys.
 *   - If activeChannel === null, show only non-channel posts (public feed).
 *   - If activeChannel is set, show only posts for that channel.
 *
 * Special post types rendered as rich cards:
 *   - Blocklist posts (BLOCKLIST_MAGIC prefix) → shows import/subscribe buttons.
 *   - Follow list posts (FOLLOWLIST_MAGIC prefix) → shows import/subscribe buttons.
 *   - Normal posts → text + optional image + optional embed widget.
 *
 * Posts are sorted newest-first by timestamp.
 * All user-supplied strings are HTML-escaped via escHtml() before insertion.
 */
function renderFeed() {
  renderFeedChannelStrip();
  const list = document.getElementById('feed-list');
  if (!list) { console.warn('[feed] feed-list element missing'); return; }
  try {
    const arr = Array.isArray(posts) ? posts.filter(p => {
      if (isBlocked(p.sender_pubkey) || blockedByPubkeys.has(p.sender_pubkey)) return false;
      const ch = parseChannelPost(p.content);
      if (activeChannel === null) {
        // Public feed: only posts with no channel tag
        return ch === null;
      } else {
        // Channel view: only posts for this channel (skip blocked channels)
        return ch !== null && ch.channel === activeChannel && !isChannelBlocked(ch.channel);
      }
    }) : [];
    if (arr.length === 0) {
      list.innerHTML = `<div class="feed-empty">${t('feed_empty')}</div>`;
      return;
    }
    const sorted = [...arr].sort((a, b) => {
      const ta = new Date(a?.timestamp || 0).getTime() || 0;
      const tb = new Date(b?.timestamp || 0).getTime() || 0;
      return tb - ta;
    });
    const html = sorted.map(p => {
      if (!p || typeof p !== 'object') return '';
      const postId      = String(p.post_id || '');
      const fingerprint = String(p.sender_fingerprint || '');
      const username    = (typeof p.sender_username === 'string' && p.sender_username) ? p.sender_username : '';
      const name        = username || fingerprint || 'unknown';
      const rawContent  = String(p.content ?? '');
      const chParsed    = parseChannelPost(rawContent);
      const content     = chParsed ? chParsed.text : rawContent;
      const likeCount   = Number.isFinite(p.like_count) ? p.like_count : 0;
      const isOwn       = !!p.is_own;
      const liked       = likedPostIds.has(postId);
      const shortId     = postId ? postId.slice(0, 8) : '--------';
      // Cache avatar from post data
      if (p.sender_pubkey && p.sender_avatar) peerAvatars[p.sender_pubkey] = p.sender_avatar;
      let timeStr = '';
      try { timeStr = formatTime(p.timestamp); } catch {}
      const postAvatarClick = !isOwn && peerAvatars[p.sender_pubkey] ? ` onclick="openPeerAvatarViewer('${escHtml(p.sender_pubkey)}')" style="cursor:pointer" title="View profile picture"` : '';

      // ── Detect shared blocklist/follow list posts ──────────────────────────
      // If the post content parses as a blocklist or follow list, render a
      // special card UI with import/subscribe controls instead of raw text.
      const bl = parseBlocklistPost(content);
      if (bl && Array.isArray(bl.pubkeys)) {
        const blListName = bl.list_name || DEFAULT_LIST_NAME;
        const blChannels = Array.isArray(bl.channels) ? bl.channels : [];
        const previewNames = bl.pubkeys.slice(0, 5).map(pk => {
          const n = (bl.names && bl.names[pk]) ? bl.names[pk] : pk.slice(0, 20) + '…';
          return `<div class="blocklist-entry">🚫 <span class="blocklist-entry-name">${escHtml(n)}</span></div>`;
        }).join('');
        const previewChannels = blChannels.slice(0, 3).map(ch =>
          `<div class="blocklist-entry">🚫 <span class="blocklist-entry-name">#${escHtml(ch)}</span></div>`
        ).join('');
        const moreCount = bl.pubkeys.length > 5 ? bl.pubkeys.length - 5 : 0;
        const moreHtml = moreCount > 0 ? `<div class="blocklist-entry-more">…and ${moreCount} more</div>` : '';
        const alreadyAll = bl.pubkeys.every(pk => isBlocked(pk) || pk === myIdentity?.pubkey);
        const isSubscribed = subscribedToBlocklists.has(subKey(p.sender_pubkey, blListName));
        const safeListName = escHtml(blListName);
        const totalItems = bl.pubkeys.length + blChannels.length;
        const countLabel = `${bl.pubkeys.length} user(s)${blChannels.length > 0 ? `, ${blChannels.length} channel(s)` : ''}`;
        const importBtn = isOwn ? '' : `<button class="btn-import-blocklist" onclick="importBlocklist(this.dataset.pubkeys,'${safeListName}',this.dataset.channels)" data-pubkeys="${escHtml(JSON.stringify(bl.pubkeys))}" data-channels="${escHtml(JSON.stringify(blChannels))}">${alreadyAll ? 'Already imported' : `Import All (${totalItems})`}</button>`;
        const subscribeBtn = isOwn ? '' : isSubscribed
          ? `<button class="btn-subscribe-blocklist subscribed" onclick="unsubscribeFromBlocklist('${escHtml(p.sender_pubkey)}','${safeListName}')" title="Click to unsubscribe">✓ Subscribed</button>`
          : `<button class="btn-subscribe-blocklist" onclick="subscribeToBlocklist('${escHtml(p.sender_pubkey)}','${safeListName}')" title="Auto-import whenever they update their blocklist">Subscribe</button>`;
        const blProfileClick = p.sender_pubkey ? `onclick="openProfile('${escHtml(p.sender_pubkey)}')"` : '';
        return `<div class="post-card${isOwn ? ' own-post' : ''}" id="post-${escHtml(postId)}">
          <div class="post-header">
            <div class="post-avatar${isOwn ? ' own' : ''}"${postAvatarClick}>${avatarContent(p.sender_pubkey, name)}</div>
            <div class="post-author">
              <div class="post-author-name profile-link" ${blProfileClick} title="View profile">${escHtml(name)}${isOwn ? ' <span style="color:var(--text-muted);font-size:9px">(you)</span>' : ''}</div>
              <div class="post-author-fp">${escHtml(fingerprint)}</div>
            </div>
            <div class="post-time">${escHtml(timeStr)}</div>
          </div>
          <div class="blocklist-card-body">
            <div class="blocklist-card-title">🚫 Shared Blocklist · <em style="font-style:normal;color:var(--text)">${escHtml(blListName)}</em> · ${countLabel}</div>
            ${previewNames}${previewChannels}${moreHtml}
            <div class="blocklist-btn-row">${importBtn}${subscribeBtn}</div>
          </div>
          <div class="post-footer"><span class="post-id-tag">${escHtml(shortId)}</span></div>
        </div>`;
      }

      // ── Detect shared follow list posts ────────────────────────────────────
      const fl = parseFollowlistPost(content);
      if (fl && Array.isArray(fl.pubkeys)) {
        const flListName = fl.list_name || DEFAULT_FOLLOW_LIST;
        const flChannels = Array.isArray(fl.channels) ? fl.channels : [];
        const previewNames = fl.pubkeys.slice(0, 5).map(pk => {
          const n = (fl.names && fl.names[pk]) ? fl.names[pk] : pk.slice(0, 20) + '…';
          return `<div class="followlist-entry">👤 <span class="followlist-entry-name">${escHtml(n)}</span></div>`;
        }).join('');
        const previewChannels = flChannels.slice(0, 3).map(ch =>
          `<div class="followlist-entry">📢 <span class="followlist-entry-name">#${escHtml(ch)}</span></div>`
        ).join('');
        const moreCount = fl.pubkeys.length > 5 ? fl.pubkeys.length - 5 : 0;
        const moreHtml = moreCount > 0 ? `<div class="followlist-entry-more">…and ${moreCount} more</div>` : '';
        const alreadyAll = fl.pubkeys.every(pk => isFollowing(pk) || pk === myIdentity?.pubkey);
        const isSubscribed = subscribedToFollowlists.has(subKey(p.sender_pubkey, flListName));
        const safeListName = escHtml(flListName);
        const totalItems = fl.pubkeys.length + flChannels.length;
        const countLabel = `${fl.pubkeys.length} user(s)${flChannels.length > 0 ? `, ${flChannels.length} channel(s)` : ''}`;
        const importBtn = isOwn ? '' : `<button class="btn-import-followlist" onclick="importFollowlist(this.dataset.pubkeys,'${safeListName}',this.dataset.channels)" data-pubkeys="${escHtml(JSON.stringify(fl.pubkeys))}" data-channels="${escHtml(JSON.stringify(flChannels))}">${alreadyAll ? 'Already imported' : `Import All (${totalItems})`}</button>`;
        const subscribeBtn = isOwn ? '' : isSubscribed
          ? `<button class="btn-subscribe-followlist subscribed" onclick="unsubscribeFromFollowlist('${escHtml(p.sender_pubkey)}','${safeListName}')" title="Click to unsubscribe">✓ Subscribed</button>`
          : `<button class="btn-subscribe-followlist" onclick="subscribeToFollowlist('${escHtml(p.sender_pubkey)}','${safeListName}')" title="Auto-import whenever they update their follow list">Subscribe</button>`;
        const flProfileClick = p.sender_pubkey ? `onclick="openProfile('${escHtml(p.sender_pubkey)}')"` : '';
        return `<div class="post-card${isOwn ? ' own-post' : ''}" id="post-${escHtml(postId)}">
          <div class="post-header">
            <div class="post-avatar${isOwn ? ' own' : ''}"${postAvatarClick}>${avatarContent(p.sender_pubkey, name)}</div>
            <div class="post-author">
              <div class="post-author-name profile-link" ${flProfileClick} title="View profile">${escHtml(name)}${isOwn ? ' <span style="color:var(--text-muted);font-size:9px">(you)</span>' : ''}</div>
              <div class="post-author-fp">${escHtml(fingerprint)}</div>
            </div>
            <div class="post-time">${escHtml(timeStr)}</div>
          </div>
          <div class="followlist-card-body">
            <div class="followlist-card-title">👥 Shared Follow List · <em style="font-style:normal;color:var(--text)">${escHtml(flListName)}</em> · ${countLabel}</div>
            ${previewNames}${previewChannels}${moreHtml}
            <div class="followlist-btn-row">${importBtn}${subscribeBtn}</div>
          </div>
          <div class="post-footer"><span class="post-id-tag">${escHtml(shortId)}</span></div>
        </div>`;
      }

      const profileClick = p.sender_pubkey ? `onclick="openProfile('${escHtml(p.sender_pubkey)}')"` : '';
      const imageHtml = p.image ? `<div class="post-image"><img src="${escHtml(p.image)}" alt="attached image" onclick="openImageViewer(this.src)"/></div>` : '';
      const embedHtml = p.embed_url ? renderEmbedHtml(p.embed_url) : '';
      return `<div class="post-card${isOwn ? ' own-post' : ''}" id="post-${escHtml(postId)}">
        <div class="post-header">
          <div class="post-avatar${isOwn ? ' own' : ''}"${postAvatarClick}>${avatarContent(p.sender_pubkey, name)}</div>
          <div class="post-author">
            <div class="post-author-name profile-link" ${profileClick} title="View profile">${escHtml(name)}${isOwn ? ' <span style="color:var(--text-muted);font-size:9px">(you)</span>' : ''}</div>
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
            💬 <span class="comment-count">${Number.isFinite(p.comment_count) ? p.comment_count : 0}</span>
          </button>
          <span class="post-id-tag">${escHtml(shortId)}</span>
        </div>
      </div>`;
    }).join('');
    list.innerHTML = html;
  } catch (e) {
    console.error('[feed] renderFeed crashed:', e);
    list.innerHTML = '<div class="feed-empty">Feed render error:<br/>' + escHtml(String(e?.message || e)) + '</div>';
  }
}

/**
 * Render the identity manager panel.  Fetches the full list of accounts from the
 * daemon (all identities, not just the active one) and displays each as a card.
 *
 * The active identity shows an "ACTIVE" badge and its avatar is click-to-edit.
 * Inactive identities show Switch and Delete buttons.  Deleting the active
 * identity is prevented by the daemon — the user must switch first.
 */
async function renderIdentityManager() {
  const resp = await window.agora?.request('list_identities', {});
  const list = resp?.result || [];
  const el = document.getElementById('id-list');
  if (list.length === 0) {
    el.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">No identities found</div>';
    return;
  }
  // Cache avatars from identity list
  for (const id of list) {
    if (id.pubkey && id.avatar) peerAvatars[id.pubkey] = id.avatar;
  }
  el.innerHTML = list.map(id => {
    const avatarHtml = avatarContent(id.pubkey, id.username || id.account_name);
    return `<div class="id-card${id.is_active ? ' active-id' : ''}">
      <div class="id-card-avatar" style="${id.is_active ? 'cursor:pointer' : ''}" ${id.is_active ? 'onclick="openAvatarModal()" title="Change profile picture"' : ''}>${avatarHtml}</div>
      <div class="id-card-info">
        <div class="id-card-account">${escHtml(id.account_name)}</div>
        <div class="id-card-name">${escHtml(id.username || '(no username)')}</div>
        <div class="id-card-fp">${escHtml(id.fingerprint)}</div>
      </div>
      <div class="id-card-actions">
        ${id.is_active
          ? '<span class="id-card-badge">ACTIVE</span>'
          : `<button class="btn-sm" onclick="switchIdentity('${escHtml(id.account_name)}')">Switch</button>
             <button class="btn-danger" onclick="deleteIdentity('${escHtml(id.account_name)}')">✕</button>`
        }
      </div>
    </div>`;
  }).join('');
}

// Render all messages for the active peer conversation from the in-memory array.
// Filters the flat `messages` array to only those sent to/received from activePeer.
// After rendering, scrolls to the bottom so the most-recent message is visible.
function renderMessages() {
  const container = document.getElementById('messages');
  if (!container) return;
  container.innerHTML = '';
  const relevant = messages.filter(m => m.own ? m.recipient === activePeer : m.sender_pubkey === activePeer);
  if (relevant.length === 0) {
    container.innerHTML = '<div class="sys-msg">No messages yet. Say hello!</div>';
    return;
  }
  relevant.forEach(m => appendMessage(m, false));
  container.scrollTop = container.scrollHeight;
}

function appendMessage(m, scroll = true) {
  const container = document.getElementById('messages');
  if (!container) return;
  const name = m.own ? (myIdentity?.username || myIdentity?.fingerprint || 'You') : (m.sender_username || m.sender_fingerprint);
  const pubkey = m.own ? myIdentity?.pubkey : m.sender_pubkey;
  const el = document.createElement('div');
  el.className = 'msg' + (m.own ? ' own' : '');
  const msgImageHtml = m.image ? `<div class="msg-image"><img src="${escHtml(m.image)}" alt="image" onclick="openImageViewer(this.src)"/></div>` : '';
  const msgAvatarClick = !m.own && peerAvatars[pubkey] ? ` onclick="openPeerAvatarViewer('${escHtml(pubkey)}')" style="cursor:pointer" title="View profile picture"` : '';
  el.innerHTML = `
    <div class="msg-avatar ${m.own ? 'self-av' : 'peer-av'}"${msgAvatarClick}>${avatarContent(pubkey, name)}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-author">${escHtml(name)}</span>
        <span class="msg-author-fp">${escHtml(m.own ? (myIdentity?.fingerprint||'') : m.sender_fingerprint)}</span>
        <span class="msg-time">${formatTime(m.timestamp)}</span>
      </div>
      <div class="msg-bubble">${m.content ? escHtml(m.content) : ''}${msgImageHtml}</div>
    </div>`;
  container.appendChild(el);
  if (scroll) container.scrollTop = container.scrollHeight;
}
