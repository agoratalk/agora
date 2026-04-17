// ── View / tab switching ───────────────────────────────────────────────────────
/**
 * View management.  There are five named views:
 *   'chat'        — DM conversation pane (right side)
 *   'feed'        — public broadcast feed
 *   'groups'      — group chat list + pane
 *   'following'   — follow-filtered feed
 *   'identities'  — identity/account manager
 *
 * showView() is the ONLY function that mutates view/tab DOM classes.  It also
 * triggers the appropriate data load for each view (refreshPosts, renderGroupList,
 * etc.) so views are never stale when first opened.
 *
 * switchTab() is a thin wrapper that maps sidebar tab names to view names.
 * Neither function calls the other, so there is no possible recursion.
 */
const VIEW_IDS = { chat: 'view-chat', feed: 'view-feed', groups: 'view-groups', following: 'view-following', identities: 'view-identities' };

function showView(name) {
  if (!VIEW_IDS[name]) { console.warn('[view] unknown view:', name); return; }
  activeView = name;

  // Toggle .active on every view container.
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(VIEW_IDS[name]);
  if (el) el.classList.add('active');
  else { console.warn('[view] missing element:', VIEW_IDS[name]); return; }

  // Toggle .active on the sidebar tabs.
  const tabName = (name === 'chat') ? 'peers' : (name === 'feed') ? 'feed' : (name === 'groups') ? 'groups' : (name === 'following') ? 'following' : null;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  if (tabName) {
    activeTab = tabName;
    document.getElementById('tab-' + tabName)?.classList.add('active');
  }

  // Show/hide sidebar footer elements based on tab
  const connectWrap  = document.getElementById('connect-input-wrap');
  const newGroupWrap = document.getElementById('new-group-wrap');
  if (connectWrap)  connectWrap.style.display  = name === 'groups' ? 'none' : '';
  if (newGroupWrap) newGroupWrap.style.display  = name === 'groups' ? '' : 'none';
  const searchWrap = document.getElementById('peer-search-wrap');
  if (searchWrap) searchWrap.style.display = (name === 'chat' || name === 'following') ? '' : 'none';

  // Trigger per-view data loads.
  if (name === 'feed') {
    Promise.resolve().then(() => refreshPosts()).catch(e => console.error('[feed] load failed:', e));
  } else if (name === 'following') {
    Promise.resolve().then(() => refreshPosts().then(() => renderFollowingFeed())).catch(e => console.error('[following] load failed:', e));
    renderPeerList(); // re-render filtered to followed peers
  } else if (name === 'identities') {
    Promise.resolve().then(() => renderIdentityManager()).catch(e => console.error('[identities] load failed:', e));
  } else if (name === 'chat') {
    renderPeerList(); // restore unfiltered peer list when coming back from following
  } else if (name === 'groups') {
    renderGroupList();
    if (!activeGroup) showGroupEmpty(true);
    else { showGroupEmpty(false); renderGroupHeader(); renderGroupMessages(); }
  }
}

function switchTab(tab) {
  if (tab === 'feed') showView('feed');
  else if (tab === 'peers') showView('chat');
  else if (tab === 'groups') showView('groups');
  else if (tab === 'following') showView('following');
}

// ── Notifications ──────────────────────────────────────────────────────────────
/**
 * In-memory notification bell.  Holds up to 30 notifications (most-recent first).
 * Notification objects: { type: 'like'|'dm'|'follow'|'comment', text: string,
 *                         subtext?: string, time: ISO string }
 * `text` may contain safe HTML (author name in <span>) — caller is responsible
 * for escaping user-supplied strings within it via escHtml().
 */
function pushNotification(n) {
  notifications.unshift(n);
  if (notifications.length > 30) notifications.pop(); // cap list to avoid unbounded memory
  renderNotifications();
  document.getElementById('notif-badge').classList.add('show');
}

function renderNotifications() {
  const list = document.getElementById('notif-list');
  if (notifications.length === 0) {
    list.innerHTML = `<div class="notif-empty">${t('notif_empty')}</div>`;
    return;
  }
  list.innerHTML = notifications.map(n =>
    `<div class="notif-item">${n.text}${n.subtext ? `<div style="color:var(--text-muted);font-size:10px;margin-top:3px">${n.subtext}</div>` : ''}<div class="notif-time">${formatTime(n.time)}</div></div>`
  ).join('');
}

function toggleNotifPanel() {
  notifPanelOpen = !notifPanelOpen;
  document.getElementById('notif-panel').classList.toggle('open', notifPanelOpen);
  if (notifPanelOpen) { document.getElementById('notif-badge').classList.remove('show'); renderNotifications(); }
}

function clearNotifs() { notifications = []; renderNotifications(); }
