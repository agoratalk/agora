//! Shared types used across all modules.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;

pub type PubKeyB64 = String;
pub type Fingerprint = String;

// ── Peer ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Peer {
    pub pubkey: PubKeyB64,
    pub fingerprint: Fingerprint,
    pub addr: SocketAddr,
    pub last_seen: DateTime<Utc>,
    pub discovery: DiscoveryMethod,
    #[serde(default)]
    pub username: Option<String>,
    /// Base64-encoded avatar image data URL (e.g. "data:image/jpeg;base64,...")
    #[serde(default)]
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DiscoveryMethod { Mdns, SubnetScan, Gossip, Bootstrap }

impl std::fmt::Display for Peer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = self.username.as_deref().unwrap_or("(unnamed)");
        write!(f, "{} [{}] @ {} (seen {})", name, &self.fingerprint, self.addr, self.last_seen.format("%H:%M:%S"))
    }
}

// ── Wire messages ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireMessage {
    Hello(HelloPayload),
    DirectMessage(DirectMessagePayload),
    Broadcast(BroadcastPayload),
    Like(LikePayload),
    Ack { message_id: String },
}

// ── Hello ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloPayload {
    pub sender_pubkey: PubKeyB64,
    pub sender_x25519_pubkey: PubKeyB64,
    pub known_peers: Vec<Peer>,
    pub timestamp: DateTime<Utc>,
    pub signature: String,
    #[serde(default)]
    pub username: Option<String>,
    /// Base64-encoded avatar image data URL propagated to peers
    #[serde(default)]
    pub avatar: Option<String>,
    /// Recent posts this node is propagating (up to 24h old)
    #[serde(default)]
    pub recent_posts: Vec<BroadcastPayload>,
}

// ── Direct message ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectMessagePayload {
    pub message_id: String,
    pub sender_pubkey: PubKeyB64,
    pub recipient_pubkey: PubKeyB64,
    pub nonce: String,
    pub ciphertext: String,
    pub signature: String,
    pub timestamp: DateTime<Utc>,
}

// ── Broadcast / public post ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BroadcastPayload {
    pub message_id: String,
    pub sender_pubkey: PubKeyB64,
    pub content: String,
    pub signature: String,
    pub timestamp: DateTime<Utc>,
    /// Optional attached image as a base64 data URL (JPEG, PNG, or WebP only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

// ── Like ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LikePayload {
    /// UUID of the liked BroadcastPayload
    pub post_id: String,
    /// pubkey of the liker
    pub liker_pubkey: PubKeyB64,
    /// display name of liker at time of liking
    #[serde(default)]
    pub liker_username: Option<String>,
    /// Ed25519 signature over "{post_id}{liker_pubkey}"
    pub signature: String,
    pub timestamp: DateTime<Utc>,
}

// ── IPC (Electron ↔ daemon) ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcResponse {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcEvent {
    pub event: String,
    pub data: serde_json::Value,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[derive(thiserror::Error, Debug)]
pub enum P2pError {
    #[error("identity error: {0}")] Identity(String),
    #[error("crypto error: {0}")] Crypto(String),
    #[error("network error: {0}")] Network(#[from] std::io::Error),
    #[error("serialisation error: {0}")] Serialisation(#[from] serde_json::Error),
    #[error("peer not found: {0}")] PeerNotFound(String),
    #[error("message expired (timestamp too old)")] MessageExpired,
    #[error("invalid signature")] InvalidSignature,
}

pub type Result<T> = std::result::Result<T, P2pError>;
