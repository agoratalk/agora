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
