//! Shared types used across all modules.
//!
//! This file is the "schema" of the entire daemon: every piece of data that
//! travels over the network, gets stored on disk, or crosses the IPC bridge
//! is defined here.  All types derive `Serialize`/`Deserialize` so they can be
//! turned into JSON for both wire transport and disk persistence.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;

// Type aliases that make the signatures of other modules self-documenting.
// A `PubKeyB64` is always a base64-encoded Ed25519 verifying key (32 bytes → 44 chars).
// A `Fingerprint` is always the human-readable colon-hex short form (e.g. "AB:CD:EF:…").
pub type PubKeyB64 = String;
pub type Fingerprint = String;

// ── Peer ─────────────────────────────────────────────────────────────────────

/// Everything the DHT knows about one remote node.
///
/// Peers are discovered through several mechanisms (see `DiscoveryMethod`) and
/// their metadata (username, avatar, bio, x25519 key) is filled in during the
/// Hello handshake and updated whenever gossip arrives.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Peer {
    /// The peer's Ed25519 verifying (public) key, base64-encoded.
    /// This is the permanent cryptographic identity of the peer — it never
    /// changes between sessions and acts as a globally unique node ID.
    pub pubkey: PubKeyB64,
    /// Short human-readable fingerprint derived from `pubkey` (SHA-256, first 8 bytes,
    /// formatted as hex pairs separated by colons: "AB:CD:EF:01:23:45:67:89").
    pub fingerprint: Fingerprint,
    /// Last known TCP socket address (IP + port) for this peer.
    pub addr: SocketAddr,
    /// UTC timestamp of the most recent successful contact (handshake or message).
    /// Used by the DHT to evict peers that haven't been seen for > 5 minutes.
    pub last_seen: DateTime<Utc>,
    /// How we first heard about this peer (affects routing priority in the DHT).
    pub discovery: DiscoveryMethod,
    /// Optional display name set by the peer themselves.
    #[serde(default)]
    pub username: Option<String>,
    /// Base64-encoded avatar image data URL (e.g. "data:image/jpeg;base64,...")
    /// Propagated peer-to-peer via the Hello handshake — no central server involved.
    #[serde(default)]
    pub avatar: Option<String>,
    /// X25519 public key announced by this peer during handshake, used for DM encryption.
    /// The sender performs an X25519 Diffie-Hellman with this key to derive the shared
    /// secret used to encrypt direct messages (see `messaging::send_direct`).
    #[serde(default)]
    pub x25519_pubkey: Option<PubKeyB64>,
    /// Short bio/description set by the peer (max 500 chars, enforced server-side).
    #[serde(default)]
    pub bio: Option<String>,
}

/// How a peer was discovered.  Used for informational display and for deciding
/// whether to prefer a directly observed address over a gossiped one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DiscoveryMethod {
    /// Found via mDNS multicast on the local network (most reliable for LAN).
    Mdns,
    /// Found by TCP-probing every host on the local /24 subnet (fallback when mDNS fails).
    SubnetScan,
    /// Learned indirectly from another peer's Hello `known_peers` list.
    Gossip,
    /// Supplied explicitly via the `--bootstrap` CLI flag or `connect` IPC command.
    Bootstrap,
}

impl std::fmt::Display for Peer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = self.username.as_deref().unwrap_or("(unnamed)");
        write!(f, "{} [{}] @ {} (seen {})", name, &self.fingerprint, self.addr, self.last_seen.format("%H:%M:%S"))
    }
}

// ── Wire messages ─────────────────────────────────────────────────────────────

/// Every frame that travels over a TCP connection between two Agora nodes is
/// one of these variants.
///
/// The wire format is: a 4-byte big-endian length prefix followed by the
/// JSON-serialised `WireMessage`.  The `#[serde(tag = "type")]` attribute
/// means the JSON includes a `"type"` field whose value is the snake_case
/// variant name (e.g. `"hello"`, `"direct_message"`, …).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireMessage {
    /// The first message sent in every connection, in both directions.
    /// Contains cryptographic proof of identity and gossip data.
    Hello(HelloPayload),
    /// An end-to-end encrypted private message for a specific recipient.
    DirectMessage(DirectMessagePayload),
    /// A public, signed post visible to all peers (gossip-propagated for 24 h).
    Broadcast(BroadcastPayload),
    /// A "heart" reaction on a public post.
    Like(LikePayload),
    /// A reply attached to a public post.
    Comment(CommentPayload),
    /// A "heart" reaction on a comment.
    CommentLike(CommentLikePayload),
    /// Sent by the receiver of a `DirectMessage` to confirm delivery.
    Ack { message_id: String },
}

// ── Hello ─────────────────────────────────────────────────────────────────────

/// The handshake payload — always the first message in any TCP connection.
///
/// It serves multiple purposes at once:
/// 1. **Identity proof** — `sender_pubkey` + `signature` let the receiver
///    verify that the sender controls the corresponding Ed25519 private key.
/// 2. **Encryption key exchange** — `sender_x25519_pubkey` gives the receiver
///    the key they need to encrypt direct messages back to this node.
/// 3. **Gossip** — `known_peers` spreads the peer table across the network so
///    nodes discover each other without any central directory.
/// 4. **Content propagation** — `recent_posts` and `recent_comments` carry the
///    last 24 hours of public content so a newly connected node catches up
///    immediately without needing to request it explicitly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloPayload {
    /// Ed25519 verifying key of the sender, base64-encoded.
    pub sender_pubkey: PubKeyB64,
    /// X25519 public key of the sender.  The receiver stores this in the DHT
    /// so it can encrypt DMs back to this node later.
    pub sender_x25519_pubkey: PubKeyB64,
    /// A copy of the sender's full DHT — all peers the sender currently knows
    /// about.  The receiver merges this into its own DHT (gossip propagation).
    pub known_peers: Vec<Peer>,
    /// When this Hello was created.  Receivers reject Hellos older than 30 s
    /// to prevent replay attacks.
    pub timestamp: DateTime<Utc>,
    /// Ed25519 signature over `"{sender_pubkey}{sender_x25519_pubkey}{timestamp}"`.
    /// Verifying this proves the sender owns the corresponding private key.
    pub signature: String,
    /// Optional human-readable display name.
    #[serde(default)]
    pub username: Option<String>,
    /// Base64-encoded avatar image data URL propagated to peers.
    #[serde(default)]
    pub avatar: Option<String>,
    /// Recent posts this node is propagating (up to 24h old, max 50).
    #[serde(default)]
    pub recent_posts: Vec<BroadcastPayload>,
    /// Short bio/description propagated to peers.
    #[serde(default)]
    pub bio: Option<String>,
    /// Recent comments this node is propagating (up to 24h old, max 200).
    #[serde(default)]
    pub recent_comments: Vec<CommentPayload>,
}

// ── Direct message ────────────────────────────────────────────────────────────

/// An encrypted private message from one node to another.
///
/// Encryption works as follows:
/// 1. Sender performs X25519 Diffie-Hellman: their X25519 secret × recipient's X25519 public.
/// 2. The 32-byte shared secret is stretched with HKDF-SHA256 (salt = "agora-v1",
///    info = `message_id`) into a 256-bit AES-GCM key.
/// 3. The plaintext is encrypted with AES-256-GCM using a fresh random 12-byte nonce.
/// 4. The Ed25519 signing key signs `"{message_id}{nonce}{ciphertext}"` to prove
///    authenticity and protect against ciphertext tampering.
///
/// Because both the nonce and ciphertext are part of the signed data, an
/// attacker cannot swap them without invalidating the signature.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectMessagePayload {
    /// UUID v4 that uniquely identifies this message (used as HKDF `info` to
    /// bind the encryption key to this specific message).
    pub message_id: String,
    /// Ed25519 public key of the sender, base64-encoded.
    pub sender_pubkey: PubKeyB64,
    /// Ed25519 public key of the intended recipient, base64-encoded.
    pub recipient_pubkey: PubKeyB64,
    /// 12-byte AES-GCM nonce, base64-encoded.
    pub nonce: String,
    /// AES-256-GCM ciphertext (includes the 16-byte authentication tag), base64-encoded.
    pub ciphertext: String,
    /// Ed25519 signature over `"{message_id}{nonce}{ciphertext}"`.
    pub signature: String,
    /// UTC timestamp when the message was created.
    pub timestamp: DateTime<Utc>,
}

// ── Broadcast / public post ───────────────────────────────────────────────────

/// A public, signed post that all peers propagate for up to 24 hours.
///
/// There is no encryption — the content is plaintext.  Authenticity is proved
/// by the Ed25519 signature, which the receiver verifies before storing or
/// forwarding the post.  The signature covers the content (and the image data
/// if present) so neither can be changed without detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BroadcastPayload {
    /// UUID v4 that uniquely identifies this post.
    /// Nodes use this to deduplicate posts they have already seen.
    pub message_id: String,
    /// Ed25519 public key of the author, base64-encoded.
    pub sender_pubkey: PubKeyB64,
    /// The human-readable post body.
    pub content: String,
    /// Ed25519 signature over `"{message_id}{content}"` (or `"{message_id}{content}{image}"` when
    /// an image is attached, so the image is also tamper-evident).
    pub signature: String,
    /// When the post was created.  Posts older than 24 h are not propagated.
    pub timestamp: DateTime<Utc>,
    /// Optional attached image as a base64 data URL (JPEG, PNG, or WebP only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Optional URL to embed from a supported platform (YouTube, Twitter/X, Vimeo, Spotify, SoundCloud).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embed_url: Option<String>,
}

// ── Like ─────────────────────────────────────────────────────────────────────

/// A "like" (heart reaction) on a public post.
///
/// The signature prevents one peer from liking a post on behalf of another.
/// The store deduplicates by `liker_pubkey` per post, so each node can only
/// like a given post once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LikePayload {
    /// UUID of the liked BroadcastPayload.
    pub post_id: String,
    /// Ed25519 public key of the person who liked the post.
    pub liker_pubkey: PubKeyB64,
    /// Display name of the liker at the time they liked (snapshot for display,
    /// since usernames can change).
    #[serde(default)]
    pub liker_username: Option<String>,
    /// Ed25519 signature over `"{post_id}{liker_pubkey}"`.
    pub signature: String,
    pub timestamp: DateTime<Utc>,
}

// ── Comment ───────────────────────────────────────────────────────────────────

/// A reply attached to a public post.
///
/// Comments are propagated like posts — any peer that has both the parent post
/// and the comment in its store will re-broadcast the comment to new peers on
/// connection.  Comments without a known parent post are silently dropped.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentPayload {
    /// UUID v4 identifying this comment (used for deduplication).
    pub comment_id: String,
    /// UUID of the parent BroadcastPayload this comment is replying to.
    pub post_id: String,
    /// Ed25519 public key of the commenter.
    pub sender_pubkey: PubKeyB64,
    /// The comment body.
    pub content: String,
    /// Ed25519 signature over `"{comment_id}{post_id}{content}"` (or
    /// `"{comment_id}{post_id}{content}{image}"` when an image is attached).
    pub signature: String,
    pub timestamp: DateTime<Utc>,
    /// Optional attached image as a base64 data URL (JPEG, PNG, or WebP only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

// ── Comment like ──────────────────────────────────────────────────────────────

/// A "like" (heart reaction) on a comment.
///
/// Mirrors `LikePayload` but targets a comment rather than a top-level post.
/// The `post_id` field is included for routing: when forwarding to peers we
/// look up the parent post to confirm we have it before propagating.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentLikePayload {
    /// UUID of the liked CommentPayload.
    pub comment_id: String,
    /// UUID of the parent post (used for routing and to update the post record).
    pub post_id: String,
    /// Ed25519 public key of the person who liked the comment.
    pub liker_pubkey: PubKeyB64,
    /// Display name snapshot of the liker.
    #[serde(default)]
    pub liker_username: Option<String>,
    /// Ed25519 signature over `"{comment_id}{liker_pubkey}"`.
    pub signature: String,
    pub timestamp: DateTime<Utc>,
}

// ── IPC (Electron ↔ daemon) ───────────────────────────────────────────────────

/// A JSON-RPC–style request sent from the Electron frontend to the daemon over
/// the local IPC TCP socket (default port 7779).
///
/// The `id` is chosen by the caller and echoed back in `IpcResponse` so the
/// frontend can match responses to in-flight requests (important when multiple
/// requests are in flight simultaneously).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcRequest {
    /// Caller-chosen request identifier.  Echoed back in the response.
    pub id: u64,
    /// Method name (e.g. `"send_dm"`, `"posts"`, `"whoami"`).
    pub method: String,
    /// Method-specific parameters as an arbitrary JSON object.
    /// Defaults to `null` / empty object when not present.
    #[serde(default)]
    pub params: serde_json::Value,
}

/// The daemon's reply to an `IpcRequest`.
///
/// Exactly one of `result` or `error` is `Some`; the other is `None`.
/// The `id` field matches the `id` from the corresponding request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcResponse {
    /// Echoed from the matching `IpcRequest`.
    pub id: u64,
    /// The method's return value on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// Human-readable error message on failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// An unsolicited push event from the daemon to the Electron frontend.
///
/// Events are broadcast to all connected IPC clients whenever something
/// interesting happens (e.g. a new message arrives, a peer connects, a like
/// is received).  The frontend subscribes by just staying connected to the
/// IPC socket — there is no explicit subscribe/unsubscribe mechanism.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcEvent {
    /// Event name (e.g. `"message"`, `"peers_updated"`, `"like_notification"`).
    pub event: String,
    /// Event-specific payload as arbitrary JSON.
    pub data: serde_json::Value,
}

// ── Errors ────────────────────────────────────────────────────────────────────

/// The unified error type for all daemon operations.
///
/// Using `thiserror` means each variant gets a human-readable `Display` impl
/// automatically.  The `#[from]` attribute on `Network` and `Serialisation`
/// lets us use `?` to convert from `std::io::Error` and `serde_json::Error`
/// without writing explicit `From` impls.
#[derive(thiserror::Error, Debug)]
pub enum P2pError {
    #[error("identity error: {0}")] Identity(String),
    #[error("crypto error: {0}")] Crypto(String),
    /// Wraps `std::io::Error` — covers TCP connect failures, file I/O, etc.
    #[error("network error: {0}")] Network(#[from] std::io::Error),
    /// Wraps `serde_json::Error` — covers JSON parse/serialise failures.
    #[error("serialisation error: {0}")] Serialisation(#[from] serde_json::Error),
    #[error("peer not found: {0}")] PeerNotFound(String),
    /// The message's timestamp is too old to accept (replay-attack protection).
    #[error("message expired (timestamp too old)")] MessageExpired,
    /// The Ed25519 signature didn't verify against the claimed public key.
    #[error("invalid signature")] InvalidSignature,
}

/// Convenience alias so callers can write `Result<T>` instead of
/// `std::result::Result<T, P2pError>`.
pub type Result<T> = std::result::Result<T, P2pError>;
