//! Post store: keeps broadcast posts for 24 hours (rolling window) and tracks likes.
//!
//! Posts older than 24h are evicted. Likes are stored per post_id.
//! On each new peer handshake the network layer hands them recent posts so
//! they can catch up without centralised storage.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::{sync::RwLock, time};

use crate::types::{BroadcastPayload, LikePayload, PubKeyB64};

const POST_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const EVICT_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredPost {
    pub payload: BroadcastPayload,
    /// pubkeys of peers who liked this post
    pub likes: Vec<LikePayload>,
}

impl StoredPost {
    pub fn like_count(&self) -> usize { self.likes.len() }
}

#[derive(Serialize, Deserialize, Default)]
struct PostFile {
    posts: Vec<StoredPost>,
}

#[derive(Clone)]
pub struct PostStore {
    inner: Arc<RwLock<PostStoreInner>>,
    path: PathBuf,
}

struct PostStoreInner {
    /// post_id → StoredPost
    posts: HashMap<String, StoredPost>,
    /// set of post_ids we've already propagated (to avoid re-broadcast loops)
    seen: HashSet<String>,
}

impl PostStore {
    pub async fn new(path: PathBuf) -> Self {
        let posts = load_posts(&path).unwrap_or_default();
        let seen: HashSet<String> = posts.keys().cloned().collect();
        let store = Self {
            inner: Arc::new(RwLock::new(PostStoreInner { posts, seen })),
            path,
        };
        store.spawn_eviction();
        store
    }

    /// Insert a new post. Returns true if this is a new (unseen) post.
    pub async fn insert(&self, payload: BroadcastPayload) -> bool {
        let mut inner = self.inner.write().await;
        if inner.seen.contains(&payload.message_id) { return false; }
        inner.seen.insert(payload.message_id.clone());
        inner.posts.insert(payload.message_id.clone(), StoredPost { payload, likes: vec![] });
        true
    }

    /// Record a like. Returns (is_new_like, post_author_pubkey).
    pub async fn add_like(&self, like: LikePayload) -> (bool, Option<PubKeyB64>) {
        let mut inner = self.inner.write().await;
        let key = like.post_id.clone();
        if let Some(post) = inner.posts.get_mut(&key) {
            // Deduplicate: one like per liker per post
            let already = post.likes.iter().any(|l| l.liker_pubkey == like.liker_pubkey);
            if already { return (false, Some(post.payload.sender_pubkey.clone())); }
            let author = post.payload.sender_pubkey.clone();
            post.likes.push(like);
            (true, Some(author))
        } else {
            (false, None)
        }
    }

    /// Get all posts younger than 24h for gossip propagation.
    pub async fn recent_posts(&self) -> Vec<BroadcastPayload> {
        let cutoff = Utc::now() - chrono::Duration::from_std(POST_TTL).unwrap();
        self.inner.read().await.posts.values()
            .filter(|p| p.payload.timestamp > cutoff)
            .map(|p| p.payload.clone())
            .collect()
    }

    /// All posts (for IPC / GUI).
    pub async fn all_posts(&self) -> Vec<StoredPost> {
        self.inner.read().await.posts.values().cloned().collect()
    }

    pub async fn get_post(&self, post_id: &str) -> Option<StoredPost> {
        self.inner.read().await.posts.get(post_id).cloned()
    }

    fn spawn_eviction(&self) {
        let store = self.clone();
        tokio::spawn(async move {
            let mut ticker = time::interval(EVICT_INTERVAL);
            loop {
                ticker.tick().await;
                store.evict().await;
                if let Err(e) = store.flush().await {
                    tracing::warn!("post store flush failed: {}", e);
                }
            }
        });
    }

    async fn evict(&self) {
        let cutoff = Utc::now() - chrono::Duration::from_std(POST_TTL).unwrap();
        let mut inner = self.inner.write().await;
        let before = inner.posts.len();
        inner.posts.retain(|_, p| p.payload.timestamp > cutoff);
        let evicted = before - inner.posts.len();
        if evicted > 0 {
            tracing::info!("post store: evicted {} expired post(s)", evicted);
            // Prune `seen` to only IDs still in `posts`, preventing unbounded growth.
            let live_ids: HashSet<String> = inner.posts.keys().cloned().collect();
            inner.seen.retain(|id| live_ids.contains(id));
        }
    }

    async fn flush(&self) -> std::io::Result<()> {
        let posts: Vec<StoredPost> = { self.inner.read().await.posts.values().cloned().collect() };
        let path = &self.path;
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
        let json = serde_json::to_string_pretty(&PostFile { posts })?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

fn load_posts(path: &PathBuf) -> Option<HashMap<String, StoredPost>> {
    if !path.exists() { return None; }
    let raw = std::fs::read_to_string(path).ok()?;
    let file: PostFile = serde_json::from_str(&raw).ok()?;
    let cutoff = Utc::now() - chrono::Duration::from_std(POST_TTL).unwrap();
    Some(
        file.posts.into_iter()
            .filter(|p| p.payload.timestamp > cutoff)
            .map(|p| (p.payload.message_id.clone(), p))
            .collect()
    )
}

pub fn default_posts_path() -> PathBuf {
    let base = if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") { PathBuf::from(xdg) }
        else if let Ok(home) = std::env::var("HOME") { PathBuf::from(home).join(".config") }
        else { PathBuf::from(".") };
    base.join("agora").join("posts.json")
}

pub fn default_dms_path() -> PathBuf {
    let base = if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") { PathBuf::from(xdg) }
        else if let Ok(home) = std::env::var("HOME") { PathBuf::from(home).join(".config") }
        else { PathBuf::from(".") };
    base.join("agora").join("dms.jsonl")
}

/// Append a DM record to the JSONL log. Best-effort; errors are logged.
pub fn append_dm(record: &serde_json::Value) {
    use std::io::Write;
    let path = default_dms_path();
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            let line = record.to_string() + "\n";
            if let Err(e) = f.write_all(line.as_bytes()) {
                tracing::warn!("dm log write failed: {}", e);
            }
        }
        Err(e) => tracing::warn!("dm log open failed: {}", e),
    }
}
