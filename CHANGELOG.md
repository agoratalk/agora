# Changelog

### Fixed

- **Follow lists now render as rich cards when published to the feed.** Previously, published follow list posts fell through to plain text rendering. They now display identically to shared blocklists, with a green-accented card showing the list name, a preview of the first 5 users, and two action buttons:
  - **Import All** — bulk-follows all pubkeys into a named follow list (disabled label if already imported)
  - **Subscribe** — auto-imports the list whenever the author re-broadcasts it; click again to unsubscribe

### Added

- `subscribedToFollowlists` — persistent Set (stored in `localStorage.agora_followlist_subs`) tracking subscriptions to peers' follow lists, mirroring the existing `subscribedToBlocklists` infrastructure.
- `importFollowlistPubkeys(pubkeys, listId, silent)` — core import logic for follow list pubkeys.
- `importFollowlist(pubkeysJson, listName)` — button handler called from rendered feed cards.
- `subscribeToFollowlist(senderPubkey, listName)` — subscribes and immediately imports the most recent matching post.
- `unsubscribeFromFollowlist(senderPubkey, listName)` — removes subscription.
- Auto-import on `refreshPosts`: iterates `subscribedToFollowlists` and silently imports the latest matching post from each subscribed peer.
- Auto-import on incoming broadcast: when a live follow list post arrives from a subscribed peer, new entries are imported automatically with a toast notification.
- CSS classes for follow list cards: `.followlist-card-body`, `.followlist-card-title`, `.followlist-entry`, `.followlist-entry-name`, `.followlist-entry-more`, `.followlist-btn-row`, `.btn-import-followlist`, `.btn-subscribe-followlist` (green-accented, mirrors blocklist card styles).

### Follow notifications

When a user follows you they send a silent `FOLLOW_SIGNAL` DM (`agora:followed:v1:`), intercepted in the DM event handler identically to how `BLOCK_SIGNAL` works. On receipt, a `pushNotification` entry is created (shows in the bell panel) and a toast fires — same path as `like_notification`. Followers are tracked in `localStorage.agora_known_followers` so each follower only notifies once. The previous approach tried to detect follows by scanning broadcast feed posts client-side, which was unreliable; the DM signal is guaranteed delivery via the same low-level path the daemon uses for block signals.

### DM notifications for followed users

Incoming DMs now only trigger a `pushNotification` + toast when the sender is someone you follow. Unfollowed senders produce no notification — their messages are still received and stored. The red dot (see below) is the only visual indicator for those messages.

### Unread DM indicator

A red dot appears next to a peer's username in the peer list when they have sent you a message you haven't opened yet. The dot clears immediately when you open the chat. Unread state is persisted in `localStorage.agora_unread_dms` so it survives reloads.

### Peer list auto-sort

Peers are now sorted into four priority buckets (within each bucket original insertion order is preserved):
1. Followed + unread messages
2. Followed, no unread
3. Not followed + unread messages
4. Not followed, no unread

Sort is bypassed when a search query is active so results stay in relevance order.

### Peer search bar

A search input above the peer list filters peers in real time by username, fingerprint, or public key (case-insensitive substring match). Works in both the Peers and Following tabs. Clicking any result opens the DM with that peer.

### Followers panel

Added a read-only followers panel accessible from a 🫂 button in the bottom-left sidebar, consistent with the existing following and blocking indicators. The button only appears when at least one follower is known. The panel lists all pubkeys who have published a follow list containing you, with their display name and fingerprint, and clicking a name opens their profile. No publish button, no multiple lists — purely a view into `knownFollowers`.

### Channels in follow/block lists + publish-to-channel

**Channels as list entries**

Both `blocklists` and `followlists` now carry a `channels: Set<string>` field alongside the existing `pubkeys` set. The field is serialised to and deserialised from `localStorage` (`agora_blocklists` / `agora_followlists`).

- **My Blocklists modal** — each list section gains a `+ Channel` button. Clicking it prompts for a channel name (known channels are suggested). Added channels appear inline with blocked users (with a "channel" subtitle) and can be removed individually. The count label reads e.g. `3 users, 2 channels`.
- **My Follow Lists modal** — identical treatment: `+ Channel` per list, followed channels shown alongside followed users with an Unfollow button.
- `isChannelBlocked(name)` now also returns `true` if any owned blocklist contains that channel, so the feed and channel strip automatically respect list-based channel blocks without needing a separate `blockedChannels` entry.
- `allFollowedChannels()` aggregates channels from all owned follow lists. The **Following feed** now includes posts from those channels (any author), in addition to posts from followed users.

**Publish lists to a specific channel**

Clicking `📢 Publish` on any list opens a new **"Publish To"** picker modal instead of broadcasting immediately. The modal offers:
- **Global (no channel)** — original behaviour, publishes to the public feed.
- One button per discovered channel — wraps the list payload inside `agora:channel:v1:{name}\n` so the post appears in that channel's feed.

Toast messages confirm the destination (e.g. `Blocklist "Spam" published to #tech`).

**Channels in shared list payloads**

- `publishBlocklist` and `publishFollowlist` include `channels: [...]` in the JSON payload.
- `parseBlocklistPost` / `parseFollowlistPost` expose the `channels` array to callers.
- Feed cards for shared lists show a preview of up to 3 channels (`📢 #name` / `🚫 #name`) and the count label reflects both users and channels (e.g. `5 user(s), 2 channel(s)`).
- The **Import All** button on feed cards now passes `data-channels` through to `importBlocklist` / `importFollowlist`, which forward them to the core import functions.
- `importBlocklistPubkeys` and `importFollowlistPubkeys` accept an optional `channels` array and merge those channels into the target list.
- Subscribe-on-arrival auto-import and the explicit `subscribeToBlocklist` / `subscribeToFollowlist` paths both import channels from the incoming payload.
- Channel-wrapped list posts (published to a channel) are correctly unwrapped before auto-import detection in the live message handler.
