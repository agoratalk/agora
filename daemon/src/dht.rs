//! Distributed Hash Table — peer registry with username support.

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

const PEER_TTL: Duration = Duration::from_secs(5 * 60);
const EVICT_INTERVAL: Duration = Duration::from_secs(60);
const PERSIST_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize)]
struct DhtFile { peers: Vec<Peer> }

#[derive(Clone)]
pub struct Dht {
    inner: Arc<RwLock<DhtInner>>,
    path: PathBuf,
}

struct DhtInner {
    peers: HashMap<PubKeyB64, Peer>,
    own_pubkey: PubKeyB64,
}

impl Dht {
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

    /// Upsert a peer. Username, avatar, bio, and x25519_pubkey are updated if provided.
    pub async fn upsert(&self, addr: SocketAddr, pubkey: PubKeyB64, method: DiscoveryMethod, username: Option<String>, avatar: Option<String>, bio: Option<String>, x25519_pubkey: Option<String>) {
        let mut inner = self.inner.write().await;
        if pubkey == inner.own_pubkey { return; }

        let fingerprint = {
            use base64::{engine::general_purpose::STANDARD as B64, Engine};
            B64.decode(&pubkey)
                .map(|b| pubkey_fingerprint(&b))
                .unwrap_or_else(|_| "??:??:??:??:??:??:??:??".into())
        };

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

        peer.addr = addr;
        peer.last_seen = Utc::now();
        if let Some(u) = username { peer.username = Some(u); }
        if let Some(a) = avatar { peer.avatar = Some(a); }
        if let Some(b) = bio { peer.bio = Some(b); }
        if let Some(x) = x25519_pubkey { peer.x25519_pubkey = Some(x); }
        if matches!(method, DiscoveryMethod::Mdns) { peer.discovery = DiscoveryMethod::Mdns; }
        let snapshot: Vec<Peer> = inner.peers.values().cloned().collect();
        let path = self.path.clone();
        drop(inner);
        tokio::task::spawn_blocking(move || { let _ = save_to_disk(&path, &snapshot); });
    }

    pub async fn merge_gossip(&self, foreign_peers: Vec<Peer>) {
        let mut inner = self.inner.write().await;
        let mut added = 0usize;
        for mut foreign in foreign_peers {
            if foreign.pubkey == inner.own_pubkey { continue; }
            use std::collections::hash_map::Entry;
            match inner.peers.entry(foreign.pubkey.clone()) {
                Entry::Vacant(v) => {
                    foreign.discovery = DiscoveryMethod::Gossip;
                    v.insert(foreign);
                    added += 1;
                }
                Entry::Occupied(mut o) => {
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

    pub async fn remove(&self, pubkey: &str) {
        let mut inner = self.inner.write().await;
        if inner.peers.remove(pubkey).is_some() {
            tracing::info!("DHT: removed peer {}", &pubkey[..8.min(pubkey.len())]);
        }
    }

    pub async fn touch(&self, pubkey: &str) {
        if let Some(p) = self.inner.write().await.peers.get_mut(pubkey) {
            p.last_seen = Utc::now();
        }
    }

    pub async fn peers(&self) -> Vec<Peer> {
        self.inner.read().await.peers.values().cloned().collect()
    }

    pub async fn get(&self, pubkey: &str) -> Option<Peer> {
        self.inner.read().await.peers.get(pubkey).cloned()
    }

    /// Non-async get using try_read (returns None on lock contention).
    pub fn get_sync(&self, pubkey: &str) -> Option<Peer> {
        self.inner.try_read().ok().and_then(|g| g.peers.get(pubkey).cloned())
    }

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

    async fn evict_stale(&self) {
        let cutoff = Utc::now() - chrono::Duration::from_std(PEER_TTL).unwrap();
        let mut inner = self.inner.write().await;
        let before = inner.peers.len();
        inner.peers.retain(|_, p| p.last_seen > cutoff);
        let evicted = before - inner.peers.len();
        if evicted > 0 { tracing::info!("DHT: evicted {} stale peer(s)", evicted); }
    }

    async fn flush_to_disk(&self) -> Result<()> {
        let peers: Vec<Peer> = { self.inner.read().await.peers.values().cloned().collect() };
        save_to_disk(&self.path, &peers)
    }

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

fn dht_path() -> Result<PathBuf> {
    let base = if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") { PathBuf::from(xdg) }
        else if let Ok(home) = std::env::var("HOME") { PathBuf::from(home).join(".config") }
        else { PathBuf::from(".") };
    Ok(base.join("agora").join("peers.json"))
}

pub fn default_dht_path() -> PathBuf {
    dht_path().unwrap_or_else(|_| PathBuf::from("peers.json"))
}

fn load_from_disk(path: &Path) -> Result<HashMap<PubKeyB64, Peer>> {
    if !path.exists() { return Ok(HashMap::new()); }
    let raw = std::fs::read_to_string(path)?;
    let file: DhtFile = serde_json::from_str(&raw)?;
    Ok(file.peers.into_iter().map(|p| (p.pubkey.clone(), p)).collect())
}

fn save_to_disk(path: &Path, peers: &[Peer]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| P2pError::Identity(format!("cannot create config dir: {e}")))?;
    }
    let json = serde_json::to_string_pretty(&DhtFile { peers: peers.to_vec() })?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}
