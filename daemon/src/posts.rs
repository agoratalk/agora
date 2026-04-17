//! Post store: keeps broadcast posts for 24 hours (rolling window) and tracks likes.
//!
//! ## Design
//! Posts are stored in a `HashMap<post_id, StoredPost>`.  A separate `HashSet`
//! of post_ids (`seen`) ensures we never count the same post twice and never
//! re-broadcast a post we've already propagated (breaking the gossip loop).
//!
//! Comments have their own `seen_comments` set for the same reason.
//!
//! ## Persistence
//! The store is flushed to `~/.config/agora/posts.json` every 5 minutes
//! (alongside eviction).  Stale posts are filtered out at load time so we
//! don't restore data older than 24h.
//!
//! ## DM log
//! Direct messages are appended to a separate JSONL file (`dms.jsonl`) so the
//! conversation history survives daemon restarts.  Each line is a JSON object
//! with `direction`, `peer_pubkey`, `content`, and `timestamp` fields.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::{sync::RwLock, time};

use crate::types::{BroadcastPayload, CommentLikePayload, CommentPayload, LikePayload, PubKeyB64};

/// How long a post is retained.  Posts older than this are evicted from
/// memory and the on-disk store.
const POST_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// How often the background eviction task wakes up.
/// 5 minutes keeps memory usage bounded without being too aggressive.
const EVICT_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// A comment on a broadcast post, with its associated likes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredComment {
    pub payload: CommentPayload,
    /// All likes recorded for this comment (one per liker pubkey, deduplicated).
    pub likes: Vec<CommentLikePayload>,
}

impl StoredComment {
    pub fn like_count(&self) -> usize { self.likes.len() }
}

/// A broadcast post with its associated likes and comments.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredPost {
    pub payload: BroadcastPayload,
    /// pubkeys of peers who liked this post
    pub likes: Vec<LikePayload>,
    #[serde(default)]
    pub comments: Vec<StoredComment>,
}

impl StoredPost {
    pub fn like_count(&self) -> usize { self.likes.len() }
    pub fn comment_count(&self) -> usize { self.comments.len() }
}

/// On-disk representation — a thin wrapper around a list of posts so the JSON
/// has a named top-level key (`posts`).
#[derive(Serialize, Deserialize, Default)]
struct PostFile {
    posts: Vec<StoredPost>,
}

/// Cheap clone-able handle to the post store.
#[derive(Clone)]
pub struct PostStore {
    inner: Arc<RwLock<PostStoreInner>>,
    /// Filesystem path for the on-disk JSON file.
    path: PathBuf,
}

/// Default maximum number of broadcast posts held in memory.
/// The frontend sends `set_post_limit` immediately on connect, so this value
/// is only active for the brief window before the frontend connects.
const DEFAULT_POST_LIMIT: usize = 50;

/// The actual mutable data, guarded by an async RwLock.
struct PostStoreInner {
    /// post_id → StoredPost
    posts: HashMap<String, StoredPost>,
    /// Set of post_ids we've already seen — prevents duplicates and re-broadcast loops.
    seen: HashSet<String>,
    /// Set of comment_ids we've already seen.
    seen_comments: HashSet<String>,
    /// Maximum number of posts to store.  Posts arriving after the limit is
    /// reached are added to `seen` (so we do not relay them) but not to `posts`.
    post_limit: usize,
}

impl PostStore {
    /// Create a new store, loading any saved posts from `path`.
    /// Posts older than `POST_TTL` are discarded at load time.
    pub async fn new(path: PathBuf) -> Self {
        let posts = load_posts(&path).unwrap_or_default();
        // Pre-populate `seen` from loaded post IDs so we don't re-broadcast
        // posts we received in a previous session.
        let seen: HashSet<String> = posts.keys().cloned().collect();
        let seen_comments: HashSet<String> = posts.values()
            .flat_map(|p| p.comments.iter().map(|c| c.payload.comment_id.clone()))
            .collect();
        let store = Self {
            inner: Arc::new(RwLock::new(PostStoreInner { posts, seen, seen_comments, post_limit: DEFAULT_POST_LIMIT })),
            path,
        };
        store.spawn_eviction();
        store
    }

    /// Insert a new post. Returns `true` if this is a new (unseen) post,
    /// `false` if it was already in our store or was rejected by the post limit.
    ///
    /// When the store is at `post_limit` capacity, the post_id is still added
    /// to `seen` so that we neither store nor relay the post.  This ensures
    /// that a post exceeding the limit does not propagate through this node.
    pub async fn insert(&self, payload: BroadcastPayload) -> bool {
        let mut inner = self.inner.write().await;
        // Deduplicate: if we have seen this post before, ignore it.
        if inner.seen.contains(&payload.message_id) { return false; }
        // Enforce post limit: mark as seen (suppresses relay) but do not store.
        if inner.posts.len() >= inner.post_limit {
            inner.seen.insert(payload.message_id.clone());
            return false;
        }
        inner.seen.insert(payload.message_id.clone());
        inner.posts.insert(payload.message_id.clone(), StoredPost { payload, likes: vec![], comments: vec![] });
        true
    }

    /// Update the maximum number of posts to keep.  Takes effect immediately
    /// for all subsequent `insert` calls; existing posts are not evicted.
    pub async fn set_post_limit(&self, limit: usize) {
        self.inner.write().await.post_limit = limit;
    }

    /// Insert a new comment. Returns `(is_new, post_author_pubkey)`.
    ///
    /// `is_new` is false if the comment was already seen.
    /// `post_author_pubkey` is the pubkey of the post's author so callers can
    /// send notifications when someone comments on their post.
    /// Returns `(false, None)` if the parent post is not in our store (the
    /// comment will arrive again when the post does via gossip).
    pub async fn insert_comment(&self, comment: CommentPayload) -> (bool, Option<PubKeyB64>) {
        let mut inner = self.inner.write().await;
        if inner.seen_comments.contains(&comment.comment_id) {
            // Return the post author even for duplicates so callers can check.
            let author = inner.posts.get(&comment.post_id).map(|p| p.payload.sender_pubkey.clone());
            return (false, author);
        }
        inner.seen_comments.insert(comment.comment_id.clone());
        if let Some(post) = inner.posts.get_mut(&comment.post_id) {
            let post_author = post.payload.sender_pubkey.clone();
            post.comments.push(StoredComment { payload: comment, likes: vec![] });
            (true, Some(post_author))
        } else {
            // Post not in our store — drop the comment (it will arrive again if the post does)
            (false, None)
        }
    }

    /// Record a comment like. Returns `(is_new, comment_author_pubkey, new_like_count)`.
    ///
    /// Deduplicates: one like per liker per comment.
    pub async fn add_comment_like(&self, like: CommentLikePayload) -> (bool, Option<PubKeyB64>, usize) {
        let mut inner = self.inner.write().await;
        // Walk all posts/comments to find the target comment.
        for post in inner.posts.values_mut() {
            for comment in post.comments.iter_mut() {
                if comment.payload.comment_id == like.comment_id {
                    // Deduplicate by liker pubkey.
                    let already = comment.likes.iter().any(|l| l.liker_pubkey == like.liker_pubkey);
                    if already {
                        return (false, Some(comment.payload.sender_pubkey.clone()), comment.like_count());
                    }
                    let author = comment.payload.sender_pubkey.clone();
                    comment.likes.push(like);
                    let count = comment.like_count();
                    return (true, Some(author), count);
                }
            }
        }
        (false, None, 0) // comment not found
    }

    /// Get a specific comment by ID (searches all posts).
    pub async fn get_comment(&self, comment_id: &str) -> Option<StoredComment> {
        let inner = self.inner.read().await;
        for post in inner.posts.values() {
            for c in &post.comments {
                if c.payload.comment_id == comment_id {
                    return Some(c.clone());
                }
            }
        }
        None
    }

    /// Count comments on a post.
    pub async fn comment_count_for_post(&self, post_id: &str) -> usize {
        self.inner.read().await.posts.get(post_id).map(|p| p.comments.len()).unwrap_or(0)
    }

    /// All recent comments (for gossip propagation via Hello).
    /// Only returns comments from posts that are themselves still within the TTL.
    pub async fn recent_comments(&self) -> Vec<CommentPayload> {
        let cutoff = Utc::now() - chrono::Duration::from_std(POST_TTL).unwrap();
        let inner = self.inner.read().await;
        let mut comments = Vec::new();
        for post in inner.posts.values() {
            if post.payload.timestamp > cutoff {
                for c in &post.comments {
                    comments.push(c.payload.clone());
                }
            }
        }
        comments
    }

    /// Record a like for a post.  Returns `(is_new, post_author_pubkey)`.
    ///
    /// Deduplicates: one like per liker per post.  If the post is not in our
    /// store, returns `(false, None)` (the like will be accepted if the post
    /// arrives later).
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
            (false, None)  // post not in store
        }
    }

    /// All likes on recent posts (for gossip propagation via Hello).
    pub async fn recent_likes(&self) -> Vec<LikePayload> {
        let cutoff = Utc::now() - chrono::Duration::from_std(POST_TTL).unwrap();
        let inner = self.inner.read().await;
        let mut likes = Vec::new();
        for post in inner.posts.values() {
            if post.payload.timestamp > cutoff {
                likes.extend(post.likes.iter().cloned());
            }
        }
        likes
    }

    /// All comment likes on recent posts (for gossip propagation via Hello).
    pub async fn recent_comment_likes(&self) -> Vec<CommentLikePayload> {
        let cutoff = Utc::now() - chrono::Duration::from_std(POST_TTL).unwrap();
        let inner = self.inner.read().await;
        let mut likes = Vec::new();
        for post in inner.posts.values() {
            if post.payload.timestamp > cutoff {
                for comment in &post.comments {
                    likes.extend(comment.likes.iter().cloned());
                }
            }
        }
        likes
    }

    /// Get all posts younger than 24h for gossip propagation via Hello.
    pub async fn recent_posts(&self) -> Vec<BroadcastPayload> {
        let cutoff = Utc::now() - chrono::Duration::from_std(POST_TTL).unwrap();
        self.inner.read().await.posts.values()
            .filter(|p| p.payload.timestamp > cutoff)
            .map(|p| p.payload.clone())
            .collect()
    }

    /// All posts (for IPC / GUI queries).  Includes posts of any age still in memory.
    pub async fn all_posts(&self) -> Vec<StoredPost> {
        self.inner.read().await.posts.values().cloned().collect()
    }

    /// Get a single post by ID.
    pub async fn get_post(&self, post_id: &str) -> Option<StoredPost> {
        self.inner.read().await.posts.get(post_id).cloned()
    }

    /// Spawn the background eviction + flush task.
    /// Wakes up every `EVICT_INTERVAL`, removes stale posts, prunes the `seen`
    /// set, and writes the store to disk.
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

    /// Remove all posts older than `POST_TTL`.
    ///
    /// Also prunes the `seen` and `seen_comments` sets to only contain IDs
    /// that are still live.  Without this pruning, the sets would grow without
    /// bound as old IDs accumulate.
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
            // Prune seen_comments for comments whose parent posts were evicted.
            let live_comment_ids: HashSet<String> = inner.posts.values()
                .flat_map(|p| p.comments.iter().map(|c| c.payload.comment_id.clone()))
                .collect();
            inner.seen_comments.retain(|id| live_comment_ids.contains(id));
        }
    }

    /// Write the current store to disk atomically (write to .tmp, then rename).
    async fn flush(&self) -> std::io::Result<()> {
        let posts: Vec<StoredPost> = { self.inner.read().await.posts.values().cloned().collect() };
        let path = &self.path;
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
        let json = serde_json::to_string_pretty(&PostFile { posts })?;
        // Write to a temp file first, then rename for an atomic update.
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

// ── Disk helpers ──────────────────────────────────────────────────────────────

/// Load posts from disk, discarding any that are older than `POST_TTL`.
/// Returns `None` if the file doesn't exist or can't be parsed (first run or
/// corrupted file — caller falls back to an empty store).
fn load_posts(path: &PathBuf) -> Option<HashMap<String, StoredPost>> {
    if !path.exists() { return None; }
    let raw = std::fs::read_to_string(path).ok()?;
    let file: PostFile = serde_json::from_str(&raw).ok()?;
    let cutoff = Utc::now() - chrono::Duration::from_std(POST_TTL).unwrap();
    Some(
        file.posts.into_iter()
            // Filter out stale posts immediately — no point loading data we'll evict.
            .filter(|p| p.payload.timestamp > cutoff)
            .map(|p| (p.payload.message_id.clone(), p))
            .collect()
    )
}

// ── Path helpers ──────────────────────────────────────────────────────────────

/// Default path for the posts JSON file.
/// Respects `$XDG_CONFIG_HOME`; falls back to `~/.config`.
pub fn default_posts_path() -> PathBuf {
    let base = if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") { PathBuf::from(xdg) }
        else if let Ok(home) = std::env::var("HOME") { PathBuf::from(home).join(".config") }
        else { PathBuf::from(".") };
    base.join("agora").join("posts.json")
}

/// Default path for the DM history JSONL file.
pub fn default_dms_path() -> PathBuf {
    let base = if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") { PathBuf::from(xdg) }
        else if let Ok(home) = std::env::var("HOME") { PathBuf::from(home).join(".config") }
        else { PathBuf::from(".") };
    base.join("agora").join("dms.jsonl")
}

/// Append a DM record to the JSONL log.
///
/// JSONL (JSON Lines) format: one JSON object per line, making it easy to
/// read the history line-by-line without parsing the entire file.
///
/// This function is best-effort: errors are logged but not propagated.
/// Losing a DM log entry is tolerable; blocking the caller on I/O is not.
pub fn append_dm(record: &serde_json::Value) {
    use std::io::Write;
    let path = default_dms_path();
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            // Each record is one line of JSON followed by a newline.
            let line = record.to_string() + "\n";
            if let Err(e) = f.write_all(line.as_bytes()) {
                tracing::warn!("dm log write failed: {}", e);
            }
        }
        Err(e) => tracing::warn!("dm log open failed: {}", e),
    }
}
