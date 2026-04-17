/**
 * state.js — Global state variables and application entry point (init).
 *
 * All variables declared here are window-globals shared across every other
 * JS module.  Scripts are loaded sequentially by index.html, so these
 * declarations are available to all other files by the time their code runs.
 *
 * ## Architecture
 *   State variables (global JS objects/arrays)
 *     └─ mutated by event handlers and IPC responses
 *   Rendering functions (renderFeed, renderPeerList, …)
 *     └─ re-render DOM from current state; called after state changes
 *   IPC layer (window.agora.request / onEvent)
 *     └─ JSON-RPC over TCP to the daemon
 *
 * ## Wire protocol for social features
 *   All social data (blocklists, follow lists, group messages) is transported
 *   through normal broadcast/DM posts using magic prefix strings so the daemon
 *   treats them as ordinary content.  The frontend parses the prefix and routes
 *   them to the appropriate handler.
 *
 *   Magic prefixes:
 *     'agora:channel:v1:'      → channel post (prepended before content)
 *     'agora:blocklist:v1:'    → shared blocklist (published as broadcast)
 *     'agora:followlist:v1:'   → shared follow list (published as broadcast)
 *     'agora:group:msg:v1:'    → group chat message (sent as DM fan-out)
 *     'agora:group:sys:v1:'    → group system event (sent as DM fan-out)
 *     'agora:blocked:v1:'      → silent block signal (sent as DM to blocked peer)
 *     'agora:followed:v1:'     → silent follow signal (sent as DM to followed peer)
 */

// ── State ──────────────────────────────────────────────────────────────────────
// Identity of the currently active account (from daemon's `whoami` response).
let myIdentity = null;
// Live peer list (from daemon's `peers` response or `peers_updated` event).
let peers = [];
// Broadcast posts in memory: { post_id, sender_pubkey, sender_fingerprint, content, timestamp, like_count, is_own }
// Updated by refreshPosts() and by real-time 'message' events.
let posts = [];         // { post_id, sender_pubkey, sender_fingerprint, content, timestamp, like_count, is_own }
let likedPostIds = new Set(); // post_ids we've liked this session — prevents double-liking
// Named blocklists: { [id]: { name, pubkeys: Set<string>, channels: Set<string>, owned: boolean } }
// `owned: true` means we created it; `owned: false` means it was imported from another peer.
let blocklists = {}; // { [id]: { name, pubkeys: Set<string>, owned: boolean } }
// Pubkeys of peers who have sent us the BLOCK_SIGNAL — we hide their messages
// and disable the reply input bar when chatting with them.
let blockedByPubkeys = new Set(); // pubkeys of users who have blocked us
// Subscription keys ("pubkey::listname") — when a subscribed peer re-broadcasts
// their blocklist/followlist, we auto-import the latest version.
let subscribedToBlocklists = new Set(); // "pubkey::listname" keys
let subscribedToFollowlists = new Set(); // "pubkey::listname" keys
let knownFollowers = new Set();           // pubkeys we know follow us (persisted)
let unreadDms = new Set();                // pubkeys with unread DMs
// Currently open DM conversation (pubkey string, or null for none selected).
let activePeer = null;
// In-memory DM history for the current session (loaded from daemon on peer select).
let messages = [];
// Notification bell items (up to 30, most-recent first).
let notifications = [];
let notifPanelOpen = false;
// Active view and tab names used to sync DOM visibility without recursion.
let activeView = 'chat'; // 'chat' | 'feed' | 'groups' | 'following' | 'identities'
let activeTab = 'peers'; // 'peers' | 'feed' | 'groups' | 'following'
// Active channel: null = public feed (no channel tag), string = show only that channel.
let activeChannel = null; // null = public feed, string = channel name
let blockedChannels = new Set(); // channel names the user has blocked
// Named follow lists: { [id]: { name, pubkeys: Set<string>, channels: Set<string>, owned: boolean } }
let followlists = {}; // { [id]: { name, pubkeys: Set<string>, owned: boolean } }
let _profilePubkey = null; // pubkey currently shown in profile modal
// Map of pubkey → avatar data URL (populated from peers list + own identity)
let peerAvatars = {};
// Map of pubkey → bio string (populated from peers list + own identity)
let peerBios = {};
// Pending avatar in the avatar-picker modal (not yet saved)
let pendingAvatarDataUrl = null;
// Pending images for post and DM composers
let pendingPostImage = null;
let pendingDmImage = null;
// Maximum posts the daemon should store/relay (synced to daemon on init).
// Persisted in localStorage so the preference survives page reloads.
let postLimit = Number(localStorage.getItem('agora_post_limit')) || 50;
// Pending embed URL auto-detected from post compose text
let pendingEmbedUrl = null;
// True when the user has explicitly dismissed the embed preview for the current draft
let embedUserCleared = false;
// Comment feature state
let commentsByPost = {};       // post_id → array of comment objects
let likedCommentIds = new Set(); // comment_ids we have liked
let activeCommentPostId = null;  // post whose comment modal is open
let pendingCommentImage = null;  // image attached to pending comment

// ── Init ───────────────────────────────────────────────────────────────────────
/**
 * Application entry point — called once from DOMContentLoaded.
 *
 * Sequence:
 *   1. Restore persisted client-side state from localStorage (blocklists,
 *      follow lists, groups, subscriptions, known followers, unread DMs).
 *   2. If no `window.agora` bridge is available (running in a plain browser
 *      without the daemon), fall back to demo data and exit early.
 *   3. Register the daemon event listener so real-time pushes are handled.
 *   4. Load live identity, peers, and posts from the daemon.
 *   5. Tell the daemon which connection type (Tor, WireGuard, …) to use.
 *   6. Auto-reconnect any VPN tunnel whose config was saved from a previous
 *      session.
 *   7. Apply the persisted UI language.
 *   8. Schedule a 30-minute interval to re-broadcast owned blocklists so
 *      subscribers who just joined receive up-to-date copies.
 */
async function init() {
  loadBlocklists();
  loadBlockedByList();
  loadBlockedChannels();
  loadFollowlists();
  loadGroups();
  loadSubscriptions();
  loadFollowlistSubs();
  loadKnownFollowers();
  loadUnreadDms();
  updateFollowersIndicator();
  if (!window.agora) {
    setConnected(false);
    loadDemoData();
    return;
  }
  window.agora.onEvent(handleDaemonEvent);
  await refreshIdentity();
  await refreshPeers();
  await refreshPosts();
  setConnected(true);
  // Push the persisted connection mode to the daemon so it routes correctly
  await window.agora.request('set_conn_type', { type: connType });
  // Push the persisted post limit so the daemon enforces it immediately
  await window.agora.request('set_post_limit', { limit: postLimit });
  // Auto-reconnect WireGuard/OpenVPN if a saved config exists
  if (VPN_TYPES.includes(connType) && window.agora?.vpnStart) {
    const saved = getStoredVpnConfig(connType);
    if (saved) {
      window.agora.vpnStart(connType, saved).then(resp => {
        if (resp?.error) toast(`${connType} auto-connect failed: ${resp.error}`, 'error');
        else toast(`${connType} tunnel restored`, 'success');
      });
    }
  }
  // Apply persisted language preference
  applyTranslations();
  // Re-broadcast all owned blocklists every 30 minutes so subscribers receive fresh updates
  setInterval(() => {
    for (const [id, list] of Object.entries(blocklists)) {
      if (list.owned && (list.pubkeys.size > 0 || (list.channels && list.channels.size > 0))) publishBlocklist(id, true);
    }
  }, 30 * 60 * 1000);
}
