//! Distributed Hash Table — peer registry with username support.
//!
//! The DHT is an in-memory HashMap (keyed by base64-encoded public key) that
//! stores everything the daemon knows about neighbouring peers: address, when
//! they were last seen, how they were discovered, and optional profile data.
//!
//! There is no real distributed routing (Kademlia etc.) — the name "DHT" is
//! used loosely to mean "the shared peer table that is gossiped around the
//! network".  Every peer periodically receives the full table from every peer
//! it connects to, so it converges quickly for small networks.
//!
//! ## Persistence
//! The table is saved to `~/.config/agora/peers.json` every
//! `PERSIST_INTERVAL` seconds, and loaded again on startup so we have
//! bootstrap addresses immediately available without waiting for mDNS.
//!
//! ## Eviction
//! Peers that haven't been seen for `PEER_TTL` (5 minutes) are evicted
//! automatically by a background task.

use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio::time;

use crate::{
    identity::pubkey_fingerprint,
    types::{DiscoveryMethod, P2pError, Peer, PubKeyB64, Result},
};

// A peer is considered stale if it hasn't sent any message in this window.
// 5 minutes is generous — handshakes happen every 60 s discovery cycle.
const PEER_TTL: Duration = Duration::from_secs(5 * 60);

// How often the background eviction task wakes up to remove stale peers.
const EVICT_INTERVAL: Duration = Duration::from_secs(60);

// How often the table is flushed to disk, even when no upsert triggered a save.
const PERSIST_INTERVAL: Duration = Duration::from_secs(30);

/// On-disk format for the peer table — just a list of peers wrapped in a struct
/// so the JSON has a named top-level key rather than a bare array.
#[derive(Serialize, Deserialize)]
struct DhtFile { peers: Vec<Peer> }

/// The public handle to the peer table.  Clone-able and `Send + Sync` because
/// the inner data is guarded by a `tokio::sync::RwLock`.
#[derive(Clone)]
pub struct Dht {
    inner: Arc<RwLock<DhtInner>>,
    /// Filesystem path where the table is persisted.
    path: PathBuf,
}

/// The actual mutable data, held behind the read-write lock.
struct DhtInner {
    /// Map from base64-encoded Ed25519 public key → full peer record.
    peers: HashMap<PubKeyB64, Peer>,
    /// Our own public key — used to skip inserting ourselves into the table
    /// when we receive gossip that contains our own entry.
    own_pubkey: PubKeyB64,
}

impl Dht {
    /// Create a new DHT, loading any previously saved peers from `path`.
    /// If the file doesn't exist or is unreadable we start with an empty table.
    pub async fn new(own_pubkey: PubKeyB64, path: PathBuf) -> Self {
        let peers = load_from_disk(&path).unwrap_or_else(|e| {
            tracing::warn!("could not load DHT from disk ({}), starting empty", e);
            HashMap::new()
        });
        let count = peers.len();
        let dht = Self {
            inner: Arc::new(RwLock::new(DhtInner { peers, own_pubkey })),
            path,
        };
        if count > 0 { tracing::info!("DHT: loaded {} peers from disk", count); }
        dht
    }

    /// Insert or update a peer record.
    ///
    /// - If the peer is new, a fresh `Peer` is created and logged.
    /// - If it already exists, only the address, timestamp, and any
    ///   non-None profile fields are updated (so existing data is never
    ///   cleared by a partial update that doesn't carry all fields).
    /// - We always prefer the `Mdns` discovery method over `Gossip` because
    ///   a locally-visible peer is considered more "direct" than a rumoured one.
    /// - After every write the table is flushed to disk in a background
    ///   blocking task so we don't block the async executor on file I/O.
    pub async fn upsert(&self, addr: SocketAddr, pubkey: PubKeyB64, method: DiscoveryMethod, username: Option<String>, avatar: Option<String>, bio: Option<String>, x25519_pubkey: Option<String>) {
        let mut inner = self.inner.write().await;
        // Never add ourselves — would cause us to try to dial ourselves.
        if pubkey == inner.own_pubkey { return; }

        // Pre-compute a human-readable fingerprint for the log message.
        let fingerprint = {
            use base64::{engine::general_purpose::STANDARD as B64, Engine};
            B64.decode(&pubkey)
                .map(|b| pubkey_fingerprint(&b))
                .unwrap_or_else(|_| "??:??:??:??:??:??:??:??".into())
        };

        // `entry().or_insert_with()` inserts only if the key is absent.
        let peer = inner.peers.entry(pubkey.clone()).or_insert_with(|| {
            tracing::info!("DHT: new peer {} @ {}", &fingerprint, addr);
            Peer {
                pubkey: pubkey.clone(),
                fingerprint: fingerprint.clone(),
                addr,
                last_seen: Utc::now(),
                discovery: method.clone(),
                username: username.clone(),
                avatar: avatar.clone(),
                bio: bio.clone(),
                x25519_pubkey: x25519_pubkey.clone(),
            }
        });

        // Always refresh the network address and activity timestamp.
        peer.addr = addr;
        peer.last_seen = Utc::now();
        // Only overwrite profile fields when the caller supplies a new value.
        if let Some(u) = username { peer.username = Some(u); }
        if let Some(a) = avatar { peer.avatar = Some(a); }
        if let Some(b) = bio { peer.bio = Some(b); }
        if let Some(x) = x25519_pubkey { peer.x25519_pubkey = Some(x); }
        // Promote discovery method to Mdns when we have direct evidence.
        if matches!(method, DiscoveryMethod::Mdns) { peer.discovery = DiscoveryMethod::Mdns; }

        // Snapshot the table *while still holding the write lock* so the saved
        // data is consistent, then drop the lock before spawning the blocking
        // file-write so we don't hold the write lock across I/O.
        let snapshot: Vec<Peer> = inner.peers.values().cloned().collect();
        let path = self.path.clone();
        drop(inner);
        // spawn_blocking moves the synchronous `std::fs` calls off the async
        // executor thread pool, preventing I/O from blocking other tasks.
        tokio::task::spawn_blocking(move || { let _ = save_to_disk(&path, &snapshot); });
    }

    /// Merge a peer list received via gossip (inside a `Hello` message).
    ///
    /// For peers we don't know: add them with `Gossip` as the discovery method.
    /// For peers we already know: update address/timestamp only if the gossip
    /// entry is fresher, but always accept new profile data (username, avatar,
    /// bio, x25519_pubkey) regardless of timestamp, because profiles can be
    /// updated independently of activity timestamps.
    pub async fn merge_gossip(&self, foreign_peers: Vec<Peer>) {
        let mut inner = self.inner.write().await;
        let mut added = 0usize;
        for mut foreign in foreign_peers {
            // Skip our own entry if it appears in someone else's gossip.
            if foreign.pubkey == inner.own_pubkey { continue; }
            use std::collections::hash_map::Entry;
            match inner.peers.entry(foreign.pubkey.clone()) {
                Entry::Vacant(v) => {
                    // Completely new peer — tag it as discovered via gossip.
                    foreign.discovery = DiscoveryMethod::Gossip;
                    v.insert(foreign);
                    added += 1;
                }
                Entry::Occupied(mut o) => {
                    // Existing peer: update address/timestamp if gossip is newer.
                    if foreign.last_seen > o.get().last_seen {
                        o.get_mut().addr = foreign.addr;
                        o.get_mut().last_seen = foreign.last_seen;
                    }
                    // Always update username if gossip carries one
                    if foreign.username.is_some() {
                        o.get_mut().username = foreign.username;
                    }
                    // Always update avatar if gossip carries one
                    if foreign.avatar.is_some() {
                        o.get_mut().avatar = foreign.avatar;
                    }
                    // Always update bio if gossip carries one
                    if foreign.bio.is_some() {
                        o.get_mut().bio = foreign.bio;
                    }
                    // Always update x25519_pubkey if gossip carries one
                    if foreign.x25519_pubkey.is_some() {
                        o.get_mut().x25519_pubkey = foreign.x25519_pubkey;
                    }
                }
            }
        }
        if added > 0 { tracing::info!("DHT gossip: added {} new peers", added); }
    }

    /// Remove a peer by public key (used when a connection fails permanently).
    pub async fn remove(&self, pubkey: &str) {
        let mut inner = self.inner.write().await;
        if inner.peers.remove(pubkey).is_some() {
            tracing::info!("DHT: removed peer {}", &pubkey[..8.min(pubkey.len())]);
        }
    }

    /// Update `last_seen` for a peer to the current time.
    /// Called every time we receive a valid message from that peer so they
    /// aren't evicted while they are actively talking to us.
    pub async fn touch(&self, pubkey: &str) {
        if let Some(p) = self.inner.write().await.peers.get_mut(pubkey) {
            p.last_seen = Utc::now();
        }
    }

    /// Return a snapshot of all known peers (cloned, so the lock is released immediately).
    pub async fn peers(&self) -> Vec<Peer> {
        self.inner.read().await.peers.values().cloned().collect()
    }

    /// Look up a peer by exact public key (base64-encoded).
    pub async fn get(&self, pubkey: &str) -> Option<Peer> {
        self.inner.read().await.peers.get(pubkey).cloned()
    }

    /// Non-async lookup that uses `try_read` — returns `None` if the lock is
    /// currently held by a writer (contention).  Used in hot paths where
    /// blocking would be unacceptable (e.g., the IPC event loop).
    pub fn get_sync(&self, pubkey: &str) -> Option<Peer> {
        self.inner.try_read().ok().and_then(|g| g.peers.get(pubkey).cloned())
    }

    /// Find a peer by fingerprint prefix.  Fingerprints are colon-separated
    /// uppercase hex (e.g. "A1:B2:C3:…").  The prefix is matched against the
    /// full fingerprint after stripping colons from both sides, so both
    /// `"A1B2"` and `"A1:B2"` work.  Returns `None` if zero or more than one
    /// peer matches (ambiguous prefix).
    pub async fn get_by_fingerprint(&self, prefix: &str) -> Option<Peer> {
        let prefix = prefix.to_uppercase();
        let inner = self.inner.read().await;
        let matches: Vec<&Peer> = inner.peers.values()
            .filter(|p| p.fingerprint.replace(':', "").starts_with(&prefix.replace(':', "")))
            .collect();
        match matches.len() {
            1 => Some(matches[0].clone()),
            0 => None,
            _ => { tracing::warn!("fingerprint prefix '{}' is ambiguous", prefix); None }
        }
    }

    pub async fn len(&self) -> usize { self.inner.read().await.peers.len() }
    pub async fn is_empty(&self) -> bool { self.len().await == 0 }

    /// Start the background maintenance tasks.  This should be called once
    /// after construction.  Two tasks are spawned:
    ///
    /// 1. **Eviction task** — wakes up every `EVICT_INTERVAL` and removes
    ///    peers whose `last_seen` is older than `PEER_TTL`.
    /// 2. **Persist task** — wakes up every `PERSIST_INTERVAL` and writes
    ///    the current table to disk, catching any writes that were missed
    ///    between upsert-triggered saves.
    pub fn spawn_background_tasks(&self) {
        { let dht = self.clone(); tokio::spawn(async move {
            let mut ticker = time::interval(EVICT_INTERVAL);
            loop { ticker.tick().await; dht.evict_stale().await; }
        }); }
        { let dht = self.clone(); tokio::spawn(async move {
            let mut ticker = time::interval(PERSIST_INTERVAL);
            loop { ticker.tick().await; if let Err(e) = dht.flush_to_disk().await { tracing::warn!("DHT flush failed: {}", e); } }
        }); }
    }

    /// Remove all peers whose `last_seen` is older than `PEER_TTL`.
    async fn evict_stale(&self) {
        // Compute the cutoff timestamp: anything before this is stale.
        let cutoff = Utc::now() - chrono::Duration::from_std(PEER_TTL).unwrap();
        let mut inner = self.inner.write().await;
        let before = inner.peers.len();
        // `retain` removes entries for which the closure returns false.
        inner.peers.retain(|_, p| p.last_seen > cutoff);
        let evicted = before - inner.peers.len();
        if evicted > 0 { tracing::info!("DHT: evicted {} stale peer(s)", evicted); }
    }

    /// Write the current peer table to disk.
    async fn flush_to_disk(&self) -> Result<()> {
        let peers: Vec<Peer> = { self.inner.read().await.peers.values().cloned().collect() };
        save_to_disk(&self.path, &peers)
    }

    /// Pretty-print the peer table to stdout (used by the REPL `peers` command).
    pub async fn print_table(&self) {
        let peers = self.peers().await;
        if peers.is_empty() { println!("  (no peers known)"); return; }
        println!("  {:<20}  {:<25}  {:<22}  {:<10}  {}", "Username", "Fingerprint", "Address", "Via", "Last seen");
        println!("  {}", "─".repeat(100));
        let mut sorted = peers;
        sorted.sort_by(|a, b| a.fingerprint.cmp(&b.fingerprint));
        for p in sorted {
            println!(
                "  {:<20}  {:<25}  {:<22}  {:<10}  {}",
                p.username.as_deref().unwrap_or("(unnamed)"),
                p.fingerprint,
                p.addr,
                format!("{:?}", p.discovery).to_lowercase(),
                p.last_seen.format("%H:%M:%S UTC"),
            );
        }
    }
}

// ── Path helpers ───────────────────────────────────────────────────────────────

/// Compute the default path for the on-disk peer table.
/// Respects `$XDG_CONFIG_HOME`; falls back to `~/.config` on UNIX.
fn dht_path() -> Result<PathBuf> {
    let base = if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") { PathBuf::from(xdg) }
        else if let Ok(home) = std::env::var("HOME") { PathBuf::from(home).join(".config") }
        else { PathBuf::from(".") };
    Ok(base.join("agora").join("peers.json"))
}

/// Public wrapper around `dht_path()` that returns a sensible fallback on error.
pub fn default_dht_path() -> PathBuf {
    dht_path().unwrap_or_else(|_| PathBuf::from("peers.json"))
}

// ── Disk I/O ───────────────────────────────────────────────────────────────────

/// Load the peer table from a JSON file.  Returns an empty map if the file
/// doesn't exist yet (first run).
fn load_from_disk(path: &Path) -> Result<HashMap<PubKeyB64, Peer>> {
    if !path.exists() { return Ok(HashMap::new()); }
    let raw = std::fs::read_to_string(path)?;
    let file: DhtFile = serde_json::from_str(&raw)?;
    // Re-key the Vec into a HashMap so lookups are O(1).
    Ok(file.peers.into_iter().map(|p| (p.pubkey.clone(), p)).collect())
}

/// Write the peer table atomically: write to a `.tmp` file, then rename
/// over the target.  This prevents a partial write from corrupting the saved
/// table if the process is killed mid-write.
fn save_to_disk(path: &Path, peers: &[Peer]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| P2pError::Identity(format!("cannot create config dir: {e}")))?;
    }
    let json = serde_json::to_string_pretty(&DhtFile { peers: peers.to_vec() })?;
    // Write to a temp file alongside the real file, then atomically rename.
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}
