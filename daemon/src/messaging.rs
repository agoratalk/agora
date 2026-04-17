//! Messaging layer: encrypted DMs, signed broadcasts, likes.
//!
//! ## Direct Messages (DM)
//! DMs use **X25519 Diffie-Hellman** for key agreement and **AES-256-GCM**
//! for authenticated encryption:
//!
//!  1. Sender performs ECDH: `shared = sender_x25519_secret × recipient_x25519_public`
//!  2. A per-message AES key is derived with HKDF-SHA-256:
//!     `key = HKDF(secret, salt="agora-v1", info=message_id)`
//!     Using the message_id as HKDF info means a replayed message cannot reuse
//!     a nonce/key pair that was valid for a different message_id.
//!  3. Plaintext is AES-256-GCM encrypted with a random 12-byte nonce.
//!  4. The sender signs `(message_id || nonce_b64 || ciphertext_b64)` with
//!     their Ed25519 signing key so the recipient can verify authenticity.
//!
//! ## Broadcasts
//! Public posts are signed with the sender's Ed25519 key.  The signature
//! covers `(message_id || content || optional_image)`.  All peers verify the
//! signature before storing or forwarding a post.  Posts are valid for 25 hours
//! (slightly longer than the 24-hour gossip window to allow for clock skew).
//!
//! ## Likes & Comments
//! Each like and comment is independently signed.  Like signatures cover
//! `(post_id || liker_pubkey)` so the same peer cannot like the same post twice
//! under different nonces.

use std::{sync::Arc, time::Duration};

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use ed25519_dalek::{Signature, Signer, Verifier};
use serde_json::json;
use sha2::Sha256;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;
use crate::{
    dht::Dht,
    identity::{verifying_key_from_b64, Identity},
    ipc::IpcBroadcaster,
    network::Network,
    posts::PostStore,
    types::{BroadcastPayload, CommentLikePayload, CommentPayload, DirectMessagePayload, LikePayload, P2pError, Result, WireMessage},
};

/// Maximum age for a DM timestamp before it is rejected.
/// Prevents replay of old ciphertexts.
const MAX_MSG_AGE: Duration = Duration::from_secs(30);
/// Broadcast/like timestamps may be up to 24h old (propagated posts)
const MAX_POST_AGE: Duration = Duration::from_secs(25 * 60 * 60);
/// HKDF salt — domain-separates the key derivation from any other potential
/// use of the same shared secret.
const HKDF_SALT: &[u8] = b"agora-v1";

/// The messaging layer.  Clone-able; all fields are either cheaply-cloned
/// handles (`Arc`, `Clone`) or `Option` wrappers around such handles.
#[derive(Clone)]
pub struct Messenger {
    identity: Arc<RwLock<Identity>>,
    dht: Dht,
    network: Network,
    post_store: PostStore,
    /// Channel for delivering decoded inbound messages to the REPL / UI.
    inbound_tx: mpsc::Sender<InboundMessage>,
    /// Optional IPC broadcaster — set after `IpcServer` is created so we can
    /// push real-time events to connected front-ends.
    ipc: Option<IpcBroadcaster>,
}

/// A decoded inbound message ready for display.
#[derive(Debug, Clone)]
pub struct InboundMessage {
    pub kind: InboundKind,
    pub sender_pubkey: String,
    pub sender_fingerprint: String,
    pub sender_username: Option<String>,
}

/// The payload of a decoded inbound message.
#[derive(Debug, Clone)]
pub enum InboundKind {
    /// Decrypted direct message.
    Direct { content: String, image: Option<String> },
    /// Verified broadcast post.
    Broadcast { content: String, post_id: String, image: Option<String> },
    /// Like notification (only sent when the liked post belongs to us).
    Like { post_id: String, post_author_pubkey: String, like_count: usize, liker_name: String },
}

impl Messenger {
    pub fn new(
        identity: Arc<RwLock<Identity>>,
        dht: Dht,
        network: Network,
        post_store: PostStore,
        inbound_tx: mpsc::Sender<InboundMessage>,
    ) -> Self {
        Self { identity, dht, network, post_store, inbound_tx, ipc: None }
    }

    pub fn set_ipc(&mut self, ipc: IpcBroadcaster) { self.ipc = Some(ipc); }

    /// Register a message handler with the network layer.
    /// The handler is called for every inbound `WireMessage`; it routes to
    /// the appropriate `handle_*` method based on the message type.
    pub async fn register_with_network(&self) {
        let me = self.clone();
        let handler: crate::network::MessageHandler = Arc::new(move |msg, _addr| {
            let me2 = me.clone();
            Box::pin(async move { me2.handle_inbound(msg).await; })
        });
        self.network.on_message(handler).await;
    }

    // ── Outbound ──────────────────────────────────────────────────────────────

    /// Encrypt and send a direct message to `recipient`.
    ///
    /// `recipient` may be a full base64 pubkey or a fingerprint prefix.
    /// The encryption scheme is X25519 DH + AES-256-GCM with an HKDF-derived
    /// per-message key.  See module-level docs for full details.
    pub async fn send_direct(&self, recipient: &str, content: &str, image: Option<&str>) -> Result<()> {
        // Resolve the recipient's full peer record from the DHT.
        let peer = self.resolve_peer(recipient).await?;
        // We need the recipient's X25519 public key to compute the shared secret.
        let their_x25519 = peer.x25519_pubkey.as_deref()
            .ok_or_else(|| P2pError::PeerNotFound(format!("no x25519 key for '{}' — connect to them first", recipient)))
            .and_then(crate::identity::x25519_public_from_b64)?;
        // X25519 Diffie-Hellman: produces a 32-byte shared secret known only
        // to the two parties.
        let shared_secret = { self.identity.read().await.x25519_secret.diffie_hellman(&their_x25519) };
        let message_id = Uuid::new_v4().to_string();
        // Derive the AES key from the shared secret using HKDF.  Including the
        // message_id as the "info" parameter means even if the same pair of
        // parties send many messages, each one uses a unique AES key.
        let aes_key = hkdf_derive(shared_secret.as_bytes(), HKDF_SALT, message_id.as_bytes());

        // If an image is attached, pack it together with the text as JSON so
        // both fields travel in a single encrypted payload.  Plain text messages
        // are left as-is for compactness.
        let plaintext = if let Some(img) = image {
            json!({"text": content, "image": img}).to_string()
        } else {
            content.to_string()
        };

        // Encrypt the plaintext with AES-256-GCM.
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&aes_key));
        let nonce_bytes: [u8; 12] = rand::random();  // random 96-bit nonce
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher.encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| P2pError::Crypto(format!("encryption failed: {e}")))?;

        let nonce_b64 = B64.encode(nonce_bytes);
        let ciphertext_b64 = B64.encode(&ciphertext);
        // Sign over (message_id || nonce || ciphertext) so the recipient can
        // verify the message wasn't tampered with and that it came from us.
        let to_sign = format!("{}{}{}", message_id, nonce_b64, ciphertext_b64);
        let sig: Signature = { self.identity.read().await.signing_key.sign(to_sign.as_bytes()) };

        let payload = DirectMessagePayload {
            message_id,
            sender_pubkey: self.identity.read().await.pubkey_b64(),
            recipient_pubkey: peer.pubkey.clone(),
            nonce: nonce_b64,
            ciphertext: ciphertext_b64,
            signature: B64.encode(sig.to_bytes()),
            timestamp: Utc::now(),
        };
        // Persist the outbound DM to the local JSONL log before sending.
        crate::posts::append_dm(&json!({
            "direction": "out", "peer_pubkey": peer.pubkey,
            "peer_fingerprint": peer.fingerprint, "peer_username": peer.username,
            "content": content, "image": image, "timestamp": payload.timestamp,
        }));
        self.network.send_to_pubkey(&peer.pubkey, WireMessage::DirectMessage(payload)).await
    }

    /// Sign and broadcast a public post.
    ///
    /// The post is stored locally first, then sent to all connected peers.
    /// Peers forward it to their peers via Hello gossip for the next 24 hours.
    pub async fn broadcast(&self, content: &str, image: Option<&str>, embed_url: Option<&str>) -> Result<()> {
        let message_id = Uuid::new_v4().to_string();
        // Include image and embed_url in signature when present so they're tamper-evident.
        let mut to_sign = format!("{}{}", message_id, content);
        if let Some(img) = image { to_sign.push_str(img); }
        if let Some(url) = embed_url { to_sign.push_str(url); }
        let sig: Signature = { self.identity.read().await.signing_key.sign(to_sign.as_bytes()) };
        let payload = BroadcastPayload {
            message_id,
            sender_pubkey: self.identity.read().await.pubkey_b64(),
            content: content.to_string(),
            signature: B64.encode(sig.to_bytes()),
            timestamp: Utc::now(),
            image: image.map(|s| s.to_string()),
            embed_url: embed_url.map(|s| s.to_string()),
        };
        // Store locally first so the post appears in our own feed immediately.
        self.post_store.insert(payload.clone()).await;
        // Fan out to all current peers.
        self.network.broadcast(WireMessage::Broadcast(payload)).await;
        Ok(())
    }

    /// Sign and broadcast a like for `post_id`.
    ///
    /// Returns the new total like count.  Deduplicates: if we already liked
    /// this post, returns the current count without re-broadcasting.
    pub async fn like_post(&self, post_id: &str) -> Result<usize> {
        let (liker_pubkey, liker_username) = {
            let id = self.identity.read().await;
            (id.pubkey_b64(), id.username.clone())
        };
        // Signature covers (post_id || liker_pubkey) — prevents the same peer
        // from liking the same post twice under different nonces.
        let to_sign = format!("{}{}", post_id, liker_pubkey);
        let sig: Signature = { self.identity.read().await.signing_key.sign(to_sign.as_bytes()) };

        let like = LikePayload {
            post_id: post_id.to_string(),
            liker_pubkey: liker_pubkey.clone(),
            liker_username: liker_username.clone(),
            signature: B64.encode(sig.to_bytes()),
            timestamp: Utc::now(),
        };

        let (is_new, _) = self.post_store.add_like(like.clone()).await;
        if !is_new {
            // Already liked — return current count without re-broadcasting.
            return Ok(self.post_store.get_post(post_id).await.map(|p| p.like_count()).unwrap_or(0));
        }

        // Propagate like to all peers so their like counts stay in sync.
        self.network.broadcast(WireMessage::Like(like)).await;

        Ok(self.post_store.get_post(post_id).await.map(|p| p.like_count()).unwrap_or(0))
    }

    /// Sign and broadcast a comment on `post_id`.
    ///
    /// The comment is stored locally and sent to all peers.
    pub async fn comment_post(&self, post_id: &str, content: &str, image: Option<&str>) -> Result<()> {
        let comment_id = Uuid::new_v4().to_string();
        // Signature covers (comment_id || post_id || content || optional_image).
        let mut to_sign = format!("{}{}{}", comment_id, post_id, content);
        if let Some(img) = image { to_sign.push_str(img); }
        let sig: Signature = { self.identity.read().await.signing_key.sign(to_sign.as_bytes()) };
        let payload = CommentPayload {
            comment_id,
            post_id: post_id.to_string(),
            sender_pubkey: self.identity.read().await.pubkey_b64(),
            content: content.to_string(),
            signature: B64.encode(sig.to_bytes()),
            timestamp: Utc::now(),
            image: image.map(|s| s.to_string()),
        };
        self.post_store.insert_comment(payload.clone()).await;
        self.network.broadcast(WireMessage::Comment(payload)).await;
        Ok(())
    }

    /// Sign and broadcast a like for `comment_id` on `post_id`.
    ///
    /// Returns the new total like count for the comment.
    pub async fn like_comment(&self, comment_id: &str, post_id: &str) -> Result<usize> {
        let (liker_pubkey, liker_username) = {
            let id = self.identity.read().await;
            (id.pubkey_b64(), id.username.clone())
        };
        // Signature covers (comment_id || liker_pubkey).
        let to_sign = format!("{}{}", comment_id, liker_pubkey);
        let sig: Signature = { self.identity.read().await.signing_key.sign(to_sign.as_bytes()) };

        let like = CommentLikePayload {
            comment_id: comment_id.to_string(),
            post_id: post_id.to_string(),
            liker_pubkey: liker_pubkey.clone(),
            liker_username,
            signature: B64.encode(sig.to_bytes()),
            timestamp: Utc::now(),
        };

        let (is_new, _, like_count) = self.post_store.add_comment_like(like.clone()).await;
        if !is_new { return Ok(like_count); }

        self.network.broadcast(WireMessage::CommentLike(like.clone())).await;

        // Notify connected IPC clients of the updated count.
        if let Some(ref ipc) = self.ipc {
            ipc.send(crate::types::IpcEvent {
                event: "comment_like_update".into(),
                data: json!({
                    "comment_id": like.comment_id,
                    "post_id": like.post_id,
                    "liker_pubkey": liker_pubkey,
                    "like_count": like_count,
                }),
            });
        }

        Ok(like_count)
    }

    // ── Inbound dispatch ──────────────────────────────────────────────────────

    /// Route an inbound wire message to the appropriate handler.
    async fn handle_inbound(&self, msg: WireMessage) {
        match msg {
            WireMessage::DirectMessage(dm) => self.handle_direct(dm).await,
            WireMessage::Broadcast(bc) => self.handle_broadcast(bc).await,
            WireMessage::Like(lk) => self.handle_like(lk).await,
            WireMessage::Comment(c) => self.handle_comment(c).await,
            WireMessage::CommentLike(cl) => self.handle_comment_like(cl).await,
            _ => {} // Ack, Hello etc. are handled at the network layer
        }
    }

    /// Verify and decrypt an inbound DM, then deliver it to the inbound channel.
    async fn handle_direct(&self, dm: DirectMessagePayload) {
        // Silently ignore DMs addressed to someone else (e.g. we received a
        // forwarded copy).
        let own_pubkey = self.identity.read().await.pubkey_b64();
        if dm.recipient_pubkey != own_pubkey { return; }
        match self.verify_and_decrypt_dm(&dm).await {
            Ok((content, image)) => {
                let fingerprint = sender_fingerprint(&dm.sender_pubkey);
                let sender_peer = self.dht.get(&dm.sender_pubkey).await;
                let sender_username = sender_peer.as_ref().and_then(|p| p.username.clone());
                let sender_avatar = sender_peer.and_then(|p| p.avatar);
                // Persist the inbound DM to the JSONL log.
                crate::posts::append_dm(&json!({
                    "direction": "in", "peer_pubkey": dm.sender_pubkey,
                    "peer_fingerprint": fingerprint, "peer_username": sender_username,
                    "content": content, "image": image, "timestamp": dm.timestamp,
                }));
                // Push to IPC clients so the front-end can update in real time.
                if let Some(ref ipc) = self.ipc {
                    ipc.send(crate::types::IpcEvent {
                        event: "message".into(),
                        data: json!({ "kind": "dm", "sender_pubkey": dm.sender_pubkey, "sender_fingerprint": fingerprint, "sender_username": sender_username, "sender_avatar": sender_avatar, "content": content, "image": image, "timestamp": dm.timestamp }),
                    });
                }
                let _ = self.inbound_tx.send(InboundMessage {
                    kind: InboundKind::Direct { content, image },
                    sender_pubkey: dm.sender_pubkey,
                    sender_fingerprint: fingerprint,
                    sender_username,
                }).await;
            }
            Err(e) => tracing::warn!("messaging: invalid DM: {}", e),
        }
    }

    /// Verify and store an inbound broadcast post.
    /// Returns early (without pushing to IPC) if the post was already known
    /// to prevent duplicate notifications.
    async fn handle_broadcast(&self, bc: BroadcastPayload) {
        if let Err(e) = self.verify_broadcast(&bc) {
            tracing::warn!("messaging: invalid broadcast: {}", e);
            return;
        }
        // `insert` returns false if the post was already in our store.
        let is_new = self.post_store.insert(bc.clone()).await;
        if !is_new { return; } // already seen, don't re-emit

        let fingerprint = sender_fingerprint(&bc.sender_pubkey);
        let sender_peer = self.dht.get(&bc.sender_pubkey).await;
        let sender_username = sender_peer.as_ref().and_then(|p| p.username.clone());
        let sender_avatar = sender_peer.and_then(|p| p.avatar);

        if let Some(ref ipc) = self.ipc {
            ipc.send(crate::types::IpcEvent {
                event: "message".into(),
                data: json!({ "kind": "broadcast", "post_id": bc.message_id, "sender_pubkey": bc.sender_pubkey, "sender_fingerprint": fingerprint, "sender_username": sender_username, "sender_avatar": sender_avatar, "content": bc.content, "image": bc.image, "timestamp": bc.timestamp, "like_count": 0 }),
            });
        }

        let _ = self.inbound_tx.send(InboundMessage {
            kind: InboundKind::Broadcast { content: bc.content, post_id: bc.message_id, image: bc.image },
            sender_pubkey: bc.sender_pubkey,
            sender_fingerprint: fingerprint,
            sender_username,
        }).await;
    }

    /// Handle an inbound like.
    ///
    /// After verifying the signature:
    ///  - Records the like in the post store (deduplicated).
    ///  - Pushes a `like_update` event to IPC clients (always).
    ///  - Pushes a `like_notification` event if the liked post belongs to us.
    ///  - Re-broadcasts to all peers so the like count propagates fully.
    async fn handle_like(&self, lk: LikePayload) {
        // Verify signature
        if let Err(e) = self.verify_like(&lk) {
            tracing::warn!("messaging: invalid like: {}", e);
            return;
        }

        let (is_new, post_author) = self.post_store.add_like(lk.clone()).await;
        if !is_new { return; }  // deduplicated — already counted

        let like_count = self.post_store.get_post(&lk.post_id).await.map(|p| p.like_count()).unwrap_or(0);
        let own_pubkey = self.identity.read().await.pubkey_b64();

        // Send IPC event: always broadcast updated like count so all open
        // tabs/windows see the new number immediately.
        if let Some(ref ipc) = self.ipc {
            ipc.send(crate::types::IpcEvent {
                event: "like_update".into(),
                data: json!({ "post_id": lk.post_id, "liker_pubkey": lk.liker_pubkey, "liker_username": lk.liker_username, "like_count": like_count }),
            });

            // If the liked post is ours, also send a notification for the
            // notification panel in the UI.
            if post_author.as_deref() == Some(&own_pubkey) {
                let liker_name = lk.liker_username.clone()
                    .or_else(|| self.dht.get_sync(&lk.liker_pubkey).and_then(|p| p.username))
                    .unwrap_or_else(|| sender_fingerprint(&lk.liker_pubkey));
                ipc.send(crate::types::IpcEvent {
                    event: "like_notification".into(),
                    data: json!({ "post_id": lk.post_id, "liker_name": liker_name, "liker_pubkey": lk.liker_pubkey, "like_count": like_count }),
                });
            }
        }

        // Propagate to all peers so like counts stay consistent across the network.
        self.network.broadcast(WireMessage::Like(lk.clone())).await;

        // Deliver to the inbound channel if the post is ours (for REPL notification).
        if let Some(author) = post_author {
            if author == own_pubkey {
                let liker_name = lk.liker_username
                    .unwrap_or_else(|| sender_fingerprint(&lk.liker_pubkey));
                let _ = self.inbound_tx.send(InboundMessage {
                    kind: InboundKind::Like { post_id: lk.post_id, post_author_pubkey: author, like_count, liker_name },
                    sender_pubkey: lk.liker_pubkey.clone(),
                    sender_fingerprint: sender_fingerprint(&lk.liker_pubkey),
                    sender_username: None,
                }).await;
            }
        }
    }

    pub fn post_store(&self) -> &PostStore { &self.post_store }

    /// Handle an inbound comment on a post.
    ///
    /// Verifies the signature, stores the comment, pushes an IPC `comment_update`
    /// event, optionally sends a `comment_notification` if it's on our post,
    /// then re-broadcasts to propagate the comment to the wider network.
    async fn handle_comment(&self, c: CommentPayload) {
        if let Err(e) = self.verify_comment(&c) {
            tracing::warn!("messaging: invalid comment: {}", e);
            return;
        }
        let (is_new, post_author) = self.post_store.insert_comment(c.clone()).await;
        if !is_new { return; } // already seen

        let post_comment_count = self.post_store.comment_count_for_post(&c.post_id).await;
        let fingerprint = sender_fingerprint(&c.sender_pubkey);
        let sender_peer = self.dht.get(&c.sender_pubkey).await;
        let sender_username = sender_peer.as_ref().and_then(|p| p.username.clone());
        let sender_avatar = sender_peer.and_then(|p| p.avatar);
        let own_pubkey = self.identity.read().await.pubkey_b64();

        if let Some(ref ipc) = self.ipc {
            ipc.send(crate::types::IpcEvent {
                event: "comment_update".into(),
                data: json!({
                    "comment_id": c.comment_id,
                    "post_id": c.post_id,
                    "sender_pubkey": c.sender_pubkey,
                    "sender_fingerprint": fingerprint,
                    "sender_username": sender_username,
                    "sender_avatar": sender_avatar,
                    "content": c.content,
                    "image": c.image,
                    "timestamp": c.timestamp,
                    "like_count": 0,
                    "post_comment_count": post_comment_count,
                }),
            });

            // Notify if someone commented on our post (but not our own comment)
            if post_author.as_deref() == Some(&own_pubkey) && c.sender_pubkey != own_pubkey {
                let commenter_name = sender_username.clone()
                    .or_else(|| self.dht.get_sync(&c.sender_pubkey).and_then(|p| p.username))
                    .unwrap_or_else(|| sender_fingerprint(&c.sender_pubkey));
                // Truncate the content to 60 chars for the notification snippet.
                let snippet: String = c.content.chars().take(60).collect();
                ipc.send(crate::types::IpcEvent {
                    event: "comment_notification".into(),
                    data: json!({
                        "comment_id": c.comment_id,
                        "post_id": c.post_id,
                        "commenter_name": commenter_name,
                        "commenter_pubkey": c.sender_pubkey,
                        "content_snippet": snippet,
                    }),
                });
            }
        }

        // Re-broadcast to all peers for propagation
        self.network.broadcast(WireMessage::Comment(c)).await;
    }

    /// Handle an inbound comment like.
    ///
    /// Similar to `handle_like` but for comments.  Pushes `comment_like_update`
    /// and optionally `comment_like_notification` if the comment is ours.
    async fn handle_comment_like(&self, cl: CommentLikePayload) {
        if let Err(e) = self.verify_comment_like(&cl) {
            tracing::warn!("messaging: invalid comment like: {}", e);
            return;
        }

        let (is_new, comment_author, like_count) = self.post_store.add_comment_like(cl.clone()).await;
        if !is_new { return; }

        let own_pubkey = self.identity.read().await.pubkey_b64();

        if let Some(ref ipc) = self.ipc {
            ipc.send(crate::types::IpcEvent {
                event: "comment_like_update".into(),
                data: json!({
                    "comment_id": cl.comment_id,
                    "post_id": cl.post_id,
                    "liker_pubkey": cl.liker_pubkey,
                    "liker_username": cl.liker_username,
                    "like_count": like_count,
                }),
            });

            // Notify if our comment was liked
            if comment_author.as_deref() == Some(&own_pubkey) {
                let liker_name = cl.liker_username.clone()
                    .or_else(|| self.dht.get_sync(&cl.liker_pubkey).and_then(|p| p.username))
                    .unwrap_or_else(|| sender_fingerprint(&cl.liker_pubkey));
                // Fetch a content snippet from the liked comment for the notification.
                let snippet: String = self.post_store.get_comment(&cl.comment_id).await
                    .map(|c| c.payload.content.chars().take(50).collect())
                    .unwrap_or_default();
                ipc.send(crate::types::IpcEvent {
                    event: "comment_like_notification".into(),
                    data: json!({
                        "comment_id": cl.comment_id,
                        "post_id": cl.post_id,
                        "liker_name": liker_name,
                        "liker_pubkey": cl.liker_pubkey,
                        "like_count": like_count,
                        "content_snippet": snippet,
                    }),
                });
            }
        }

        // Re-broadcast to all peers
        self.network.broadcast(WireMessage::CommentLike(cl)).await;
    }

    // ── Verification ──────────────────────────────────────────────────────────

    /// Verify the Ed25519 signature and decrypt the AES-256-GCM ciphertext of a DM.
    ///
    /// Checks:
    ///  1. Timestamp is within `MAX_MSG_AGE` (anti-replay).
    ///  2. Ed25519 signature over (message_id || nonce || ciphertext) is valid.
    ///  3. X25519 DH gives us the same shared secret as the sender used.
    ///  4. AES-256-GCM decryption succeeds (authenticates + decrypts).
    ///
    /// Returns the decoded (text, optional_image) pair on success.
    async fn verify_and_decrypt_dm(&self, dm: &DirectMessagePayload) -> Result<(String, Option<String>)> {
        // Reject messages with timestamps far in the past to prevent replay attacks.
        let age = Utc::now().signed_duration_since(dm.timestamp).to_std()
            .unwrap_or(MAX_MSG_AGE + Duration::from_secs(1));
        if age > MAX_MSG_AGE { return Err(P2pError::MessageExpired); }

        // Verify the Ed25519 signature.
        let vk = verifying_key_from_b64(&dm.sender_pubkey)?;
        let sig_bytes = B64.decode(&dm.signature).map_err(|_| P2pError::InvalidSignature)?;
        let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| P2pError::InvalidSignature)?;
        vk.verify(format!("{}{}{}", dm.message_id, dm.nonce, dm.ciphertext).as_bytes(),
            &Signature::from_bytes(&sig_arr)).map_err(|_| P2pError::InvalidSignature)?;

        // Reconstruct the shared ECDH secret: sender_public × our_secret.
        let sender_peer = self.dht.get(&dm.sender_pubkey).await;
        let their_x25519 = sender_peer.as_ref()
            .and_then(|p| p.x25519_pubkey.as_deref())
            .ok_or_else(|| P2pError::Crypto("no x25519 key for sender".into()))
            .and_then(crate::identity::x25519_public_from_b64)?;
        let shared_secret = { self.identity.read().await.x25519_secret.diffie_hellman(&their_x25519) };
        // Derive the same AES key the sender used.
        let aes_key = hkdf_derive(shared_secret.as_bytes(), HKDF_SALT, dm.message_id.as_bytes());
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&aes_key));
        let nonce_bytes = B64.decode(&dm.nonce).map_err(|_| P2pError::Crypto("bad nonce".into()))?;
        if nonce_bytes.len() != 12 { return Err(P2pError::Crypto("nonce must be 12 bytes".into())); }
        let ciphertext = B64.decode(&dm.ciphertext).map_err(|_| P2pError::Crypto("bad ciphertext".into()))?;
        // Decrypt-and-authenticate.  GCM provides both confidentiality and integrity.
        let plaintext_bytes = cipher.decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
            .map_err(|_| P2pError::Crypto("decryption failed".into()))?;
        let plaintext = String::from_utf8(plaintext_bytes).map_err(|_| P2pError::Crypto("invalid UTF-8".into()))?;

        // If the plaintext is JSON with "text"/"image" fields, extract them;
        // otherwise treat the whole plaintext as plain text (legacy DMs).
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&plaintext) {
            if let Some(text) = v.get("text").and_then(|t| t.as_str()) {
                let image = v.get("image").and_then(|i| i.as_str()).map(|s| s.to_string());
                return Ok((text.to_string(), image));
            }
        }
        Ok((plaintext, None))
    }

    /// Verify the Ed25519 signature on a broadcast payload.
    /// Also checks that the timestamp is within the 25-hour post TTL.
    fn verify_broadcast(&self, bc: &BroadcastPayload) -> Result<()> {
        let age = Utc::now().signed_duration_since(bc.timestamp).to_std()
            .unwrap_or(MAX_POST_AGE + Duration::from_secs(1));
        if age > MAX_POST_AGE { return Err(P2pError::MessageExpired); }
        let vk = verifying_key_from_b64(&bc.sender_pubkey)?;
        let sig_bytes = B64.decode(&bc.signature).map_err(|_| P2pError::InvalidSignature)?;
        let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| P2pError::InvalidSignature)?;
        // Image-bearing posts sign over {id}{content}{image}; legacy posts sign over {id}{content}.
        let signed = if let Some(ref img) = bc.image {
            format!("{}{}{}", bc.message_id, bc.content, img)
        } else {
            format!("{}{}", bc.message_id, bc.content)
        };
        vk.verify(signed.as_bytes(), &Signature::from_bytes(&sig_arr)).map_err(|_| P2pError::InvalidSignature)
    }

    /// Verify the Ed25519 signature on a like payload.
    /// Signature covers (post_id || liker_pubkey).
    fn verify_like(&self, lk: &LikePayload) -> Result<()> {
        let vk = verifying_key_from_b64(&lk.liker_pubkey)?;
        let sig_bytes = B64.decode(&lk.signature).map_err(|_| P2pError::InvalidSignature)?;
        let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| P2pError::InvalidSignature)?;
        vk.verify(format!("{}{}", lk.post_id, lk.liker_pubkey).as_bytes(),
            &Signature::from_bytes(&sig_arr)).map_err(|_| P2pError::InvalidSignature)
    }

    /// Verify the Ed25519 signature on a comment payload.
    /// Signature covers (comment_id || post_id || content || optional_image).
    fn verify_comment(&self, c: &CommentPayload) -> Result<()> {
        let age = Utc::now().signed_duration_since(c.timestamp).to_std()
            .unwrap_or(MAX_POST_AGE + Duration::from_secs(1));
        if age > MAX_POST_AGE { return Err(P2pError::MessageExpired); }
        let vk = verifying_key_from_b64(&c.sender_pubkey)?;
        let sig_bytes = B64.decode(&c.signature).map_err(|_| P2pError::InvalidSignature)?;
        let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| P2pError::InvalidSignature)?;
        let mut signed = format!("{}{}{}", c.comment_id, c.post_id, c.content);
        if let Some(ref img) = c.image { signed.push_str(img); }
        vk.verify(signed.as_bytes(), &Signature::from_bytes(&sig_arr)).map_err(|_| P2pError::InvalidSignature)
    }

    /// Verify the Ed25519 signature on a comment-like payload.
    /// Signature covers (comment_id || liker_pubkey).
    fn verify_comment_like(&self, cl: &CommentLikePayload) -> Result<()> {
        let vk = verifying_key_from_b64(&cl.liker_pubkey)?;
        let sig_bytes = B64.decode(&cl.signature).map_err(|_| P2pError::InvalidSignature)?;
        let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| P2pError::InvalidSignature)?;
        vk.verify(format!("{}{}", cl.comment_id, cl.liker_pubkey).as_bytes(),
            &Signature::from_bytes(&sig_arr)).map_err(|_| P2pError::InvalidSignature)
    }

    /// Look up a peer by full pubkey or fingerprint prefix.
    async fn resolve_peer(&self, recipient: &str) -> Result<crate::types::Peer> {
        // Try exact pubkey match first (most common case).
        if let Some(peer) = self.dht.get(recipient).await { return Ok(peer); }
        // Fall back to fingerprint prefix lookup.
        if let Some(peer) = self.dht.get_by_fingerprint(recipient).await { return Ok(peer); }
        Err(P2pError::PeerNotFound(format!("'{}' — use `peers` to list known nodes", recipient)))
    }
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

/// Derive a 32-byte key using a simplified HKDF (RFC 5869) over SHA-256.
///
/// HKDF has two phases:
///  1. Extract: `PRK = HMAC-SHA256(salt, input_key_material)` — produces a
///     pseudo-random key of uniform distribution.
///  2. Expand:  `OKM = HMAC-SHA256(PRK, info || 0x01)` — stretches to the
///     desired output length (here 32 bytes = one SHA-256 block).
///
/// Using the message_id as `info` ensures two parties who share the same ECDH
/// secret always derive a *different* AES key for each message.
fn hkdf_derive(secret: &[u8], salt: &[u8], info: &[u8]) -> [u8; 32] {
    // Extract phase: PRK = HMAC(salt, secret)
    let prk = hmac_sha256(salt, secret);
    // Expand phase (single block because output is 32 bytes = one HMAC output).
    let mut expand_input = info.to_vec();
    expand_input.push(0x01);  // counter byte required by HKDF spec
    hmac_sha256(&prk, &expand_input)
}

/// Compute HMAC-SHA-256 manually using the standard IPAD/OPAD construction.
///
/// The 64-byte key block is XOR'd with 0x36 (inner pad) and 0x5c (outer pad).
/// If the key is longer than 64 bytes it is first hashed to 32 bytes.
fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    let mut k = [0u8; 64];  // SHA-256 block size is 64 bytes
    if key.len() > 64 {
        // Keys longer than the block size are hashed first.
        let h = Sha256::digest(key); k[..32].copy_from_slice(&h);
    }
    else { k[..key.len()].copy_from_slice(key); }
    let ipad: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    let opad: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    // Inner hash: H(ipad || data)
    let mut inner = Sha256::new(); inner.update(&ipad); inner.update(data);
    let inner_hash = { use sha2::digest::FixedOutput; inner.finalize_fixed() };
    // Outer hash: H(opad || inner_hash)
    let mut outer = Sha256::new(); outer.update(&opad); outer.update(inner_hash);
    use sha2::digest::FixedOutput; outer.finalize_fixed().into()
}

/// Compute the human-readable fingerprint of a base64-encoded public key.
/// Returns a colon-separated uppercase hex string like `"A1:B2:…:08"`.
fn sender_fingerprint(pubkey_b64: &str) -> String {
    B64.decode(pubkey_b64)
        .map(|b| crate::identity::pubkey_fingerprint(&b))
        .unwrap_or_else(|_| "??:??:??:??:??:??:??:??".into())
}
