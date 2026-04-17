// ── Comments ───────────────────────────────────────────────────────────────────
/**
 * Comment system overview:
 *   - Comments are stored on the daemon and propagated via gossip like posts.
 *   - openPostComments() fetches fresh comments from the daemon via `get_comments`
 *     and merges with any already-in-memory comments from real-time events.
 *   - The merge is conservative: we keep the higher like count when both sources
 *     have a record for the same comment_id.
 *   - submitComment() adds an optimistic local entry immediately (marked
 *     'pending-…') before the daemon responds, so the UI feels instant.
 *   - likeComment() also applies an optimistic increment and rolls back on error.
 *   - Comments are sorted by like count descending (most popular first), with
 *     timestamp ascending as a stable tiebreaker for equal counts.
 */

async function openPostComments(postId) {
  activeCommentPostId = postId;
  clearCommentImage();
  document.getElementById('comment-input').value = '';

  // Render the post preview at the top of the modal
  const post = posts.find(p => p.post_id === postId);
  const viewPost = document.getElementById('comment-view-post');
  if (post) {
    const name = post.sender_username || post.sender_fingerprint || 'unknown';
    let timeStr = '';
    try { timeStr = formatTime(post.timestamp); } catch {}
    const content = (() => { const ch = parseChannelPost(post.content); return ch ? ch.text : post.content; })();
    viewPost.innerHTML = `
      <div class="post-header">
        <div class="post-avatar${post.is_own ? ' own' : ''}">${avatarContent(post.sender_pubkey, name)}</div>
        <div class="post-author">
          <div class="post-author-name">${escHtml(name)}${post.is_own ? ' <span style="color:var(--text-muted);font-size:9px">(you)</span>' : ''}</div>
          <div class="post-author-fp">${escHtml(post.sender_fingerprint || '')}</div>
        </div>
        <div class="post-time">${escHtml(timeStr)}</div>
      </div>
      ${content ? `<div class="post-content">${escHtml(content)}</div>` : ''}
      ${post.image ? `<div class="post-image" style="margin-top:8px"><img src="${escHtml(post.image)}" alt="attached image" onclick="openImageViewer(this.src)" style="max-height:160px;width:auto;border-radius:6px;border:1px solid var(--line);cursor:pointer"/></div>` : ''}`;
  } else {
    viewPost.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">Post not found</div>';
  }

  // Fetch fresh comments from daemon
  document.getElementById('comment-modal').classList.add('open');
  document.getElementById('comment-list').innerHTML = '<div class="comment-empty">Loading…</div>';

  const resp = await window.agora?.request('get_comments', { post_id: postId });
  if (resp?.result) {
    // Merge with local cache (local cache may have newer data from real-time events)
    const fetched = resp.result;
    if (!commentsByPost[postId]) commentsByPost[postId] = [];
    for (const fc of fetched) {
      const ei = commentsByPost[postId].findIndex(c => c.comment_id === fc.comment_id);
      if (ei < 0) commentsByPost[postId].push({ ...fc, is_own: fc.sender_pubkey === myIdentity?.pubkey });
      else {
        // Merge: keep higher like count
        if (fc.like_count > (commentsByPost[postId][ei].like_count || 0)) {
          commentsByPost[postId][ei].like_count = fc.like_count;
        }
      }
    }
  }
  renderCommentList();
  setTimeout(() => document.getElementById('comment-input')?.focus(), 100);
}

/**
 * Re-render the comment list for the currently open comment modal.
 *
 * Applies the same blocked/blocking-us filter as the feed.
 * Sort order: most-liked first (Reddit-style), with timestamp ascending as
 * a stable tiebreaker so comments with equal likes appear in chronological order.
 */
function renderCommentList() {
  const list = document.getElementById('comment-list');
  if (!list || activeCommentPostId === null) return;
  const comments = (commentsByPost[activeCommentPostId] || [])
    .filter(c => !isBlocked(c.sender_pubkey) && !blockedByPubkeys.has(c.sender_pubkey));
  if (comments.length === 0) {
    list.innerHTML = '<div class="comment-empty">No comments yet. Be the first!</div>';
    return;
  }
  // Sort by like count descending, then by timestamp ascending as tiebreaker
  const sorted = [...comments].sort((a, b) => {
    const diff = (b.like_count || 0) - (a.like_count || 0);
    if (diff !== 0) return diff;
    return new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
  });
  list.innerHTML = sorted.map(c => {
    const name = c.sender_username || c.sender_fingerprint || 'unknown';
    const liked = likedCommentIds.has(c.comment_id);
    const likeCount = Number.isFinite(c.like_count) ? c.like_count : 0;
    let timeStr = '';
    try { timeStr = formatTime(c.timestamp); } catch {}
    const imageHtml = c.image ? `<div class="comment-image"><img src="${escHtml(c.image)}" alt="image" onclick="openImageViewer(this.src)"/></div>` : '';
    return `<div class="comment-card${c.is_own ? ' own-comment' : ''}">
      <div class="post-header">
        <div class="post-avatar${c.is_own ? ' own' : ''}" style="width:28px;height:28px;font-size:11px">${avatarContent(c.sender_pubkey, name)}</div>
        <div class="post-author">
          <div class="post-author-name">${escHtml(name)}${c.is_own ? ' <span style="color:var(--text-muted);font-size:9px">(you)</span>' : ''}</div>
          <div class="post-author-fp">${escHtml(c.sender_fingerprint || '')}</div>
        </div>
        <div class="post-time">${escHtml(timeStr)}</div>
      </div>
      ${c.content ? `<div class="post-content" style="font-size:13px">${escHtml(c.content)}</div>` : ''}
      ${imageHtml}
      <div class="comment-footer">
        <button class="like-btn${liked ? ' liked' : ''}" onclick="likeComment('${escHtml(c.comment_id)}','${escHtml(c.post_id)}')" title="Like comment">
          <span class="heart">❤</span> <span>${likeCount}</span>
        </button>
      </div>
    </div>`;
  }).join('');
}

async function submitComment() {
  if (!activeCommentPostId) return;
  const input = document.getElementById('comment-input');
  const content = input.value.trim();
  const image = pendingCommentImage;
  if (!content && !image) return;
  input.value = '';
  clearCommentImage();

  const params = { post_id: activeCommentPostId, content };
  if (image) params.image = image;
  const resp = await window.agora?.request('comment_post', params);
  if (resp?.error) {
    toast('Comment failed: ' + resp.error, 'error');
    return;
  }
  // Optimistically add our own comment to the local cache
  const myComment = {
    comment_id: 'pending-' + Date.now(),
    post_id: activeCommentPostId,
    sender_pubkey: myIdentity?.pubkey || '',
    sender_fingerprint: myIdentity?.fingerprint || '',
    sender_username: myIdentity?.username || null,
    content,
    image: image || null,
    timestamp: new Date().toISOString(),
    like_count: 0,
    is_own: true,
  };
  if (!commentsByPost[activeCommentPostId]) commentsByPost[activeCommentPostId] = [];
  commentsByPost[activeCommentPostId].push(myComment);
  // Update post comment count
  const post = posts.find(p => p.post_id === activeCommentPostId);
  if (post) { post.comment_count = (post.comment_count || 0) + 1; renderFeed(); renderFollowingFeed(); }
  renderCommentList();
}

async function likeComment(commentId, postId) {
  if (likedCommentIds.has(commentId)) return;
  likedCommentIds.add(commentId);
  // Optimistic update
  if (commentsByPost[postId]) {
    const c = commentsByPost[postId].find(c => c.comment_id === commentId);
    if (c) { c.like_count = (c.like_count || 0) + 1; renderCommentList(); }
  }
  const resp = await window.agora?.request('like_comment', { comment_id: commentId, post_id: postId });
  if (resp?.error) {
    likedCommentIds.delete(commentId);
    if (commentsByPost[postId]) {
      const c = commentsByPost[postId].find(c => c.comment_id === commentId);
      if (c) { c.like_count = Math.max(0, (c.like_count || 1) - 1); renderCommentList(); }
    }
    toast('Like failed: ' + resp.error, 'error');
    return;
  }
  if (resp?.result) {
    if (commentsByPost[postId]) {
      const c = commentsByPost[postId].find(c => c.comment_id === commentId);
      if (c) { c.like_count = resp.result.like_count; renderCommentList(); }
    }
  }
}

function clearCommentImage() {
  pendingCommentImage = null;
  document.getElementById('comment-attach-preview').style.display = 'none';
  document.getElementById('comment-attach-thumb').src = '';
  document.getElementById('comment-attach-btn').classList.remove('has-image');
}

/**
 * Like a post.  Uses an optimistic UI update:
 *   1. Add to likedPostIds immediately (prevents double-click before response).
 *   2. Increment the local like_count and re-render.
 *   3. Send the like RPC to the daemon.
 *   4a. On error: revert both the Set entry and the local count.
 *   4b. On success: authoritative count from daemon may differ (race with other
 *       likers) — apply it.
 */
async function likePost(postId) {
  if (likedPostIds.has(postId)) return; // already liked
  likedPostIds.add(postId);
  // Optimistic update — shows the like immediately without waiting for network round-trip
  const post = posts.find(p => p.post_id === postId);
  if (post) { post.like_count++; renderFeed(); }

  const resp = await window.agora?.request('like_post', { post_id: postId });
  if (resp?.error) {
    likedPostIds.delete(postId);
    if (post) { post.like_count--; renderFeed(); }
    toast('Like failed: ' + resp.error, 'error');
    return;
  }
  if (resp?.result) {
    if (post) { post.like_count = resp.result.like_count; renderFeed(); }
  }
}

async function dialPeer() {
  const addr = document.getElementById('connect-input').value.trim();
  if (!addr) return;
  const resp = await window.agora?.request('connect', { addr });
  if (resp?.error) toast('Connect failed: ' + resp.error, 'error');
  else { toast('Dialling ' + addr + '…', 'success'); document.getElementById('connect-input').value = ''; }
}

function openUsernameModal() {
  document.getElementById('username-input').value = myIdentity?.username || '';
  document.getElementById('username-modal').classList.add('open');
  setTimeout(() => document.getElementById('username-input').focus(), 100);
}

async function saveUsername() {
  const uname = document.getElementById('username-input').value.trim();
  if (!uname) return;
  closeModal('username-modal');
  const resp = await window.agora?.request('set_username', { username: uname });
  if (resp?.error) toast('Failed: ' + resp.error, 'error');
  else { if (myIdentity) myIdentity.username = uname; document.getElementById('my-name').textContent = uname; toast('Username updated', 'success'); }
}

function openAvatarModal() {
  pendingAvatarDataUrl = myIdentity?.avatar || null;
  const preview = document.getElementById('avatar-preview');
  const name = myIdentity?.username || myIdentity?.fingerprint || '?';
  if (pendingAvatarDataUrl) {
    preview.innerHTML = `<img src="${escHtml(pendingAvatarDataUrl)}" alt=""/>`;
  } else {
    preview.innerHTML = `<span id="avatar-preview-initial">${escHtml(name[0].toUpperCase())}</span>`;
  }
  document.getElementById('avatar-modal').classList.add('open');
}

function clearAvatar() {
  pendingAvatarDataUrl = null;
  const name = myIdentity?.username || myIdentity?.fingerprint || '?';
  document.getElementById('avatar-preview').innerHTML = `<span id="avatar-preview-initial">${escHtml(name[0].toUpperCase())}</span>`;
}

async function saveAvatar() {
  closeModal('avatar-modal');
  const resp = await window.agora?.request('set_avatar', { avatar: pendingAvatarDataUrl });
  if (resp?.error) { toast('Failed to save avatar: ' + resp.error, 'error'); return; }
  // Update local state
  if (myIdentity) {
    myIdentity.avatar = pendingAvatarDataUrl;
    if (myIdentity.pubkey) {
      if (pendingAvatarDataUrl) peerAvatars[myIdentity.pubkey] = pendingAvatarDataUrl;
      else delete peerAvatars[myIdentity.pubkey];
    }
  }
  renderIdentityAvatar();
  toast('Profile picture updated', 'success');
}

// ── Image attachment helpers ───────────────────────────────────────────────────
/**
 * Images attached to posts, DMs, and comments are sent as base64-encoded data
 * URLs embedded directly in the JSON payload.  To keep payloads manageable:
 *
 *   processImageFile() — used for post/DM/comment attachments:
 *     - Validates MIME type (JPEG, PNG, WebP only).
 *     - Proportionally scales down to max 1200×1200 while preserving aspect ratio.
 *     - Re-encodes as the original format at quality 0.82 (JPEG) or lossless (PNG/WebP).
 *
 *   Avatar processing (inline in the DOMContentLoaded handler):
 *     - Crops to square from centre (cover-fit), then scales to 128×128.
 *     - Ensures a uniform avatar size across the UI regardless of original dimensions.
 *
 * All image data is stored and transmitted as data URLs ("data:image/…;base64,…").
 */
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function processImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      reject(new Error('Image must be JPEG, PNG, or WebP'));
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not load image'));
      img.onload = () => {
        const MAX = 1200;
        let w = img.width, h = img.height;
        // Scale down proportionally if either dimension exceeds the max.
        if (w > MAX || h > MAX) {
          if (w >= h) { h = Math.round(h * MAX / w); w = MAX; }
          else { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        // Preserve the original format; JPEG quality 0.82 is a good size/quality trade-off.
        const outType = file.type === 'image/png' ? 'image/png'
                      : file.type === 'image/webp' ? 'image/webp'
                      : 'image/jpeg';
        resolve(canvas.toDataURL(outType, 0.82));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function clearPostImage() {
  pendingPostImage = null;
  document.getElementById('post-attach-preview').style.display = 'none';
  document.getElementById('post-attach-thumb').src = '';
  document.getElementById('post-attach-btn').classList.remove('has-image');
}

function clearDmImage() {
  pendingDmImage = null;
  document.getElementById('dm-attach-preview').style.display = 'none';
  document.getElementById('dm-attach-thumb').src = '';
  document.getElementById('dm-attach-btn').classList.remove('has-image');
}

// Full-screen image viewer — click anywhere (or the backdrop) to dismiss.
// Created dynamically so there's no persistent DOM element to hide/show.
function openImageViewer(src) {
  const backdrop = document.createElement('div');
  backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:300;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 4px 32px rgba(0,0,0,.7)';
  backdrop.appendChild(img);
  backdrop.onclick = () => document.body.removeChild(backdrop);
  document.body.appendChild(backdrop);
}

function openPeerAvatarViewer(pubkey) {
  const src = pubkey && peerAvatars[pubkey];
  if (src) openImageViewer(src);
}

async function createIdentity() {
  const name = document.getElementById('new-acct-name').value.trim();
  const username = document.getElementById('new-acct-user').value.trim() || undefined;
  if (!name) { toast('Account name required', 'error'); return; }
  const resp = await window.agora?.request('create_identity', { account_name: name, username });
  if (resp?.error) toast('Error: ' + resp.error, 'error');
  else {
    document.getElementById('new-acct-name').value = '';
    document.getElementById('new-acct-user').value = '';
    toast(`Identity "${name}" created`, 'success');
    renderIdentityManager();
  }
}

async function switchIdentity(accountName) {
  const resp = await window.agora?.request('switch_identity', { account_name: accountName });
  if (resp?.error) toast('Error: ' + resp.error, 'error');
  else {
    toast(`Switched to "${accountName}"`, 'success');
    await refreshIdentity();
    await refreshPosts();
    renderIdentityManager();
  }
}

async function deleteIdentity(accountName) {
  if (!confirm(`Delete identity "${accountName}"? This cannot be undone.`)) return;
  const resp = await window.agora?.request('delete_identity', { account_name: accountName });
  if (resp?.error) toast('Error: ' + resp.error, 'error');
  else { toast(`Deleted "${accountName}"`, 'success'); renderIdentityManager(); }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'comment-modal') { activeCommentPostId = null; clearCommentImage(); }
}
