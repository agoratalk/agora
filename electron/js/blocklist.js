// ── Blocklist helpers ──────────────────────────────────────────────────────────
/**
 * Blocklists are named collections of pubkeys (and optionally channel names) that
 * filter content in the feed and peer list.  Multiple named lists are supported so
 * the user can separate personal blocks from subscribed community lists.
 *
 * Only `owned` lists actively filter content — imported lists that the user hasn't
 * taken ownership of are stored but not applied.  This lets the user preview a
 * community blocklist before opting in.
 *
 * Subscription keys have the form "pubkey::listname".  When a subscribed peer
 * re-publishes their blocklist, it is auto-imported silently.
 */
const DEFAULT_LIST_NAME = 'Default';

// Returns true if the pubkey appears in any of the user's owned blocklists.
function isBlocked(pk) {
  if (!pk) return false;
  for (const list of Object.values(blocklists)) {
    if (list.owned && list.pubkeys.has(pk)) return true;
  }
  return false;
}

// Returns the union of all pubkeys across owned blocklists.
function allBlockedPubkeys() {
  const all = new Set();
  for (const list of Object.values(blocklists)) {
    if (list.owned) for (const pk of list.pubkeys) all.add(pk);
  }
  return all;
}

// Generate a collision-resistant list ID from current timestamp + random bits.
function newListId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Canonical subscription key: "pubkey::listname".  Stored in localStorage so
// subscriptions survive page reloads.
function subKey(pubkey, listName) {
  return pubkey + '::' + (listName || DEFAULT_LIST_NAME);
}

// Find an existing owned list with the given name, or create one if absent.
// Used when importing from a subscription or from the onboarding screen.
function getOrCreateOwnedList(name) {
  for (const [id, list] of Object.entries(blocklists)) {
    if (list.owned && list.name === name) return id;
  }
  const id = newListId();
  blocklists[id] = { name, pubkeys: new Set(), channels: new Set(), owned: true };
  return id;
}

function getDefaultOwnedListId() {
  for (const [id, list] of Object.entries(blocklists)) {
    if (list.owned) return id;
  }
  return getOrCreateOwnedList(DEFAULT_LIST_NAME);
}

// ── Block list persistence ─────────────────────────────────────────────────────
/**
 * Blocklists are serialised to localStorage as JSON.  Sets are stored as arrays
 * since JSON.stringify can't handle Set objects directly, and are reconstructed
 * on load.
 *
 * Migration path: the original version used a single flat 'agora_blocked' array.
 * On first load with the new format absent, that array is migrated into a named
 * list so users don't lose their blocklist on upgrade.
 */
function loadBlocklists() {
  try {
    const newData = localStorage.getItem('agora_blocklists');
    if (newData) {
      const parsed = JSON.parse(newData);
      blocklists = {};
      for (const [id, list] of Object.entries(parsed)) {
        // Reconstruct Sets from plain arrays (JSON serialisation flattens them)
        blocklists[id] = { name: list.name, pubkeys: new Set(list.pubkeys || []), channels: new Set(list.channels || []), owned: !!list.owned };
      }
    } else {
      // Migrate from old single-list format
      const oldBlocked = localStorage.getItem('agora_blocked');
      if (oldBlocked) {
        const oldPubkeys = JSON.parse(oldBlocked);
        if (oldPubkeys.length > 0) {
          const id = newListId();
          blocklists[id] = { name: DEFAULT_LIST_NAME, pubkeys: new Set(oldPubkeys), owned: true };
          saveBlocklists();
        }
      }
    }
  } catch {}
  updateBlockedIndicator();
}

function saveBlocklists() {
  try {
    const serializable = {};
    for (const [id, list] of Object.entries(blocklists)) {
      serializable[id] = { name: list.name, pubkeys: [...list.pubkeys], channels: [...(list.channels || [])], owned: list.owned };
    }
    localStorage.setItem('agora_blocklists', JSON.stringify(serializable));
  } catch {}
  updateBlockedIndicator();
}

// Silent signal DMs — these are never shown in the chat UI.
// BLOCK_SIGNAL: sent to a peer when we block them so their client knows to
//   show "this user has blocked you" instead of silently dropping our future DMs.
// FOLLOW_SIGNAL: sent to a peer when we follow them so we appear in their
//   followers list without requiring them to be online to discover it.
const BLOCK_SIGNAL  = 'agora:blocked:v1:';
const FOLLOW_SIGNAL = 'agora:followed:v1:';

function loadBlockedByList() {
  try {
    const saved = localStorage.getItem('agora_blocked_by');
    if (saved) blockedByPubkeys = new Set(JSON.parse(saved));
  } catch {}
}

function saveBlockedByList() {
  try { localStorage.setItem('agora_blocked_by', JSON.stringify([...blockedByPubkeys])); } catch {}
}
