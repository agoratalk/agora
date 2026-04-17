// ── Event handling ─────────────────────────────────────────────────────────────
/**
 * Central dispatcher for all real-time events pushed from the daemon.
 *
 * Event types and data shapes:
 *   connection_failed     — IPC connection lost
 *   peers_updated         — { pubkey, username, fingerprint, avatar, bio, … }[]
 *   message               — { kind:'dm'|'broadcast', sender_pubkey, content, … }
 *   like_update           — { post_id, like_count }
 *   like_notification     — { liker_name, post_id, like_count }
 *   comment_update        — { post_id, comment_id, sender_pubkey, content, … }
 *   comment_like_update   — { post_id, comment_id, like_count }
 *   comment_notification  — { commenter_name, content_snippet }
 *   comment_like_notification — { liker_name, content_snippet, like_count }
 *   username_changed      — (no data; triggers refreshIdentity)
 *   avatar_changed        — (no data; triggers refreshIdentity)
 *   bio_changed           — (no data; triggers refreshIdentity)
 *   identity_switched     — { account_name }
 *   tor_status            — { status: 'bootstrapping'|'ready'|'failed', error? }
 *
 * The 'message' case handles both broadcast posts and DMs.  Within the DM
 * branch, group protocol messages (magic prefix) are routed to handleGroupDm
 * before any normal message processing.
 */
function handleDaemonEvent(ev) {
  switch (ev.event) {
    case 'connection_failed':
      setConnected(false);
      toast('Cannot connect to daemon', 'error');
      break;

    case 'peers_updated':
      peers = ev.data;
      for (const p of peers) {
        if (p.pubkey && p.avatar) peerAvatars[p.pubkey] = p.avatar;
        if (p.pubkey && p.bio) peerBios[p.pubkey] = p.bio;
      }
      renderPeerList();
      break;

    case 'message': {
      const d = ev.data;
      // Silently drop all content from users we have blocked
      if (isBlocked(d.sender_pubkey)) break;
      // Detect and handle block signal — the sender is telling us they blocked us
      if (d.kind !== 'broadcast' && d.content === BLOCK_SIGNAL) {
        blockedByPubkeys.add(d.sender_pubkey);
        saveBlockedByList();
        renderPeerList();
        renderFeed();
        if (activePeer === d.sender_pubkey) updateInputBarBlockedBy();
        break; // do not show this system message in the chat
      }
      // Detect follow signal — someone just followed us
      if (d.kind !== 'broadcast' && d.content === FOLLOW_SIGNAL) {
        if (!knownFollowers.has(d.sender_pubkey)) {
          knownFollowers.add(d.sender_pubkey);
          saveKnownFollowers();
          updateFollowersIndicator();
          const name = d.sender_username || d.sender_fingerprint || d.sender_pubkey.slice(0, 8);
          pushNotification({
            type: 'follow',
            text: `<span class="notif-name">${escHtml(name)}</span> followed you`,
            time: new Date().toISOString(),
          });
          toast(`${name} followed you`, 'success');
        }
        break; // do not show this system message in the chat
      }
      // Cache sender avatar if provided
      if (d.sender_pubkey && d.sender_avatar) peerAvatars[d.sender_pubkey] = d.sender_avatar;
      if (d.kind === 'broadcast') {
        // Upsert post in feed
        const existing = posts.findIndex(p => p.post_id === d.post_id);
        const post = {
          post_id: d.post_id,
          sender_pubkey: d.sender_pubkey,
          sender_fingerprint: d.sender_fingerprint,
          sender_username: d.sender_username,
          sender_avatar: d.sender_avatar,
          content: d.content,
          image: d.image || null,
          timestamp: d.timestamp,
          like_count: d.like_count || 0,
          is_own: d.sender_pubkey === myIdentity?.pubkey,
        };
        if (existing >= 0) posts[existing] = post;
        else posts.unshift(post);
        renderFeed();
        renderFollowingFeed();
        if (!post.is_own) {
          checkFollowNotifications([post]);
          const _chW = parseChannelPost(post.content);
          const _innerC = _chW ? _chW.text : post.content;
          const isFollowListPost = parseFollowlistPost(_innerC) !== null || parseBlocklistPost(_innerC) !== null;
          if (!isFollowListPost) toast(`📢 ${displayName(d)}: ${d.content.slice(0, 60)}`, 'info');
        }
        // Auto-import if we're subscribed to this peer's blocklist or follow list
        if (!post.is_own) {
          // Unwrap channel prefix if the list was published to a channel
          const chWrapped = parseChannelPost(post.content);
          const postInnerContent = chWrapped ? chWrapped.text : post.content;
          const bl = parseBlocklistPost(postInnerContent);
          if (bl) {
            const key = subKey(post.sender_pubkey, bl.list_name);
            if (subscribedToBlocklists.has(key)) {
              const importId = getOrCreateOwnedList('Imported from ' + (post.sender_username || post.sender_pubkey.slice(0, 8)));
              const added = importBlocklistPubkeys(bl.pubkeys, importId, true, bl.channels || []);
              if (added > 0) toast(`Auto-imported ${added} new item(s) from subscribed blocklist`, 'success');
            }
          }
          const fl = parseFollowlistPost(postInnerContent);
          if (fl) {
            const key = subKey(post.sender_pubkey, fl.list_name || DEFAULT_FOLLOW_LIST);
            if (subscribedToFollowlists.has(key)) {
              const listId = getOrCreateFollowList('Imported from ' + (post.sender_username || post.sender_pubkey.slice(0, 8)));
              const added = importFollowlistPubkeys(fl.pubkeys, listId, true, fl.channels || []);
              if (added > 0) toast(`Auto-imported ${added} new item(s) from subscribed follow list`, 'success');
            }
          }
        }
      } else {
        // DM — check if it's a group protocol message first
        const rawContent = String(d.content || '');
        if (rawContent.startsWith(GROUP_MSG_MAGIC) || rawContent.startsWith(GROUP_SYS_MAGIC)) {
          handleGroupDm(d);
          break;
        }
        const msg = { kind:'dm', own:false, sender_pubkey:d.sender_pubkey, sender_fingerprint:d.sender_fingerprint, sender_username:d.sender_username, content:rawContent, image:d.image||null, timestamp:d.timestamp||new Date().toISOString() };
        messages.push(msg);
        if (activePeer === d.sender_pubkey) {
          appendMessage(msg);
        } else {
          // Mark unread and re-sort peer list
          unreadDms.add(d.sender_pubkey);
          saveUnreadDms();
          renderPeerList();
          // Only notify if we follow this person
          if (isFollowing(d.sender_pubkey)) {
            const senderName = displayName(d);
            pushNotification({
              type: 'dm',
              text: `<span class="notif-name">${escHtml(senderName)}</span> sent you a message`,
              subtext: escHtml(rawContent.slice(0, 80)),
              time: new Date().toISOString(),
            });
            toast(`💬 ${senderName}: ${rawContent.slice(0, 60)}`, 'info');
          }
        }
      }
      break;
    }

    case 'like_update': {
      const d = ev.data;
      const post = posts.find(p => p.post_id === d.post_id);
      if (post) {
        post.like_count = d.like_count;
        // Keep post.likes in sync so the scoring algorithm has liker identity data
        // without needing a full refreshPosts() call.
        if (!Array.isArray(post.likes)) post.likes = [];
        if (d.liker_pubkey && !post.likes.some(l => l.liker_pubkey === d.liker_pubkey)) {
          post.likes.push({ liker_pubkey: d.liker_pubkey, liker_username: d.liker_username || null });
        }
        renderFeed();
        renderFollowingFeed();
      }
      break;
    }

    case 'like_notification': {
      const d = ev.data;
      pushNotification({
        type: 'like',
        text: `<span class="notif-name">${escHtml(d.liker_name)}</span> liked your post`,
        subtext: `"${escHtml(truncate(posts.find(p=>p.post_id===d.post_id)?.content||'', 50))}"  ·  ❤ ${d.like_count}`,
        time: new Date().toISOString(),
      });
      toast(`❤ ${d.liker_name} liked your post (total: ${d.like_count})`, 'like');
      break;
    }

    case 'comment_update': {
      const d = ev.data;
      if (isBlocked(d.sender_pubkey)) break;
      // Update post comment count in feed
      const post = posts.find(p => p.post_id === d.post_id);
      if (post) { post.comment_count = d.post_comment_count; renderFeed(); renderFollowingFeed(); }
      // Store in local comment cache
      if (!commentsByPost[d.post_id]) commentsByPost[d.post_id] = [];
      const ci = commentsByPost[d.post_id].findIndex(c => c.comment_id === d.comment_id);
      const commentObj = { ...d, is_own: d.sender_pubkey === myIdentity?.pubkey };
      if (ci < 0) commentsByPost[d.post_id].push(commentObj);
      else commentsByPost[d.post_id][ci] = commentObj;
      // Refresh modal if it's open for this post
      if (activeCommentPostId === d.post_id) renderCommentList();
      break;
    }

    case 'comment_like_update': {
      const d = ev.data;
      if (commentsByPost[d.post_id]) {
        const c = commentsByPost[d.post_id].find(c => c.comment_id === d.comment_id);
        if (c) { c.like_count = d.like_count; }
      }
      if (activeCommentPostId === d.post_id) renderCommentList();
      break;
    }

    case 'comment_notification': {
      const d = ev.data;
      pushNotification({
        type: 'comment',
        text: `<span class="notif-name">${escHtml(d.commenter_name)}</span> commented on your post`,
        subtext: escHtml(truncate(d.content_snippet || '', 60)),
        time: new Date().toISOString(),
      });
      toast(`💬 ${d.commenter_name} commented on your post`, 'info');
      break;
    }

    case 'comment_like_notification': {
      const d = ev.data;
      pushNotification({
        type: 'like',
        text: `<span class="notif-name">${escHtml(d.liker_name)}</span> liked your comment`,
        subtext: `"${escHtml(truncate(d.content_snippet || '', 50))}"  ·  ❤ ${d.like_count}`,
        time: new Date().toISOString(),
      });
      toast(`❤ ${d.liker_name} liked your comment (total: ${d.like_count})`, 'like');
      break;
    }

    case 'username_changed':
      refreshIdentity();
      break;

    case 'avatar_changed':
      refreshIdentity();
      break;

    case 'bio_changed':
      refreshIdentity();
      break;

    case 'identity_switched':
      refreshIdentity();
      refreshPosts();
      toast(`Switched to "${ev.data.account_name}"`, 'success');
      break;

    case 'tor_status': {
      const s = ev.data.status;
      if (s === 'bootstrapping') {
        // Update the connection label to show Tor is starting up
        const lbl = document.getElementById('conn-label');
        if (lbl && !lbl.textContent.includes('disconnected')) {
          lbl.textContent = 'TOR — bootstrapping…';
        }
        toast('Tor: building circuits… (may take up to a minute)', 'info');
      } else if (s === 'ready') {
        const lbl = document.getElementById('conn-label');
        if (lbl) lbl.textContent = 'connected - TOR';
        toast('Tor ready — all traffic is now anonymised', 'success');
        // Refresh the exit IP if the connection menu is open
        const menu = document.getElementById('conn-menu');
        if (menu && menu.style.display !== 'none') fetchAndShowIps();
      } else if (s === 'failed') {
        toast(`Tor bootstrap failed: ${ev.data.error || 'unknown error'}`, 'error');
        const lbl = document.getElementById('conn-label');
        if (lbl) lbl.textContent = 'TOR — bootstrap failed';
      }
      break;
    }
  }
}
