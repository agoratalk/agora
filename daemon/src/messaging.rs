//! Messaging layer: encrypted DMs, signed broadcasts, likes.

use std::{sync::Arc, time::Duration};

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use ed25519_dalek::{Signature, Signer, Verifier};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;
use x25519_dalek::PublicKey as X25519Public;

use crate::{
    dht::Dht,
    identity::{verifying_key_from_b64, Identity},
    ipc::IpcBroadcaster,
    network::Network,
    posts::PostStore,
    types::{BroadcastPayload, DirectMessagePayload, LikePayload, P2pError, Result, WireMessage},
};

const MAX_MSG_AGE: Duration = Duration::from_secs(30);
/// Broadcast/like timestamps may be up to 24h old (propagated posts)
const MAX_POST_AGE: Duration = Duration::from_secs(25 * 60 * 60);
const HKDF_SALT: &[u8] = b"agora-v1";

#[derive(Clone)]
pub struct Messenger {
    identity: Arc<RwLock<Identity>>,
    dht: Dht,
    network: Network,
    post_store: PostStore,
    inbound_tx: mpsc::Sender<InboundMessage>,
    ipc: Option<IpcBroadcaster>,
}

#[derive(Debug, Clone)]
pub struct InboundMessage {
    pub kind: InboundKind,
    pub sender_pubkey: String,
    pub sender_fingerprint: String,
    pub sender_username: Option<String>,
}

#[derive(Debug, Clone)]
pub enum InboundKind {
    Direct { content: String },
    Broadcast { content: String, post_id: String },
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

    pub async fn register_with_network(&self) {
        let me = self.clone();
        let handler: crate::network::MessageHandler = Arc::new(move |msg, _addr| {
            let me2 = me.clone();
            Box::pin(async move { me2.handle_inbound(msg).await; })
        });
        self.network.on_message(handler).await;
    }

    pub async fn send_direct(&self, recipient: &str, content: &str) -> Result<()> {
        let peer = self.resolve_peer(recipient).await?;
        let their_x25519 = x25519_pubkey_for_peer(&peer.pubkey)?;
        let shared_secret = { self.identity.read().await.x25519_secret.diffie_hellman(&their_x25519) };
        let message_id = Uuid::new_v4().to_string();
        let aes_key = hkdf_derive(shared_secret.as_bytes(), HKDF_SALT, message_id.as_bytes());

        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&aes_key));
        let nonce_bytes: [u8; 12] = rand::random();
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher.encrypt(nonce, content.as_bytes())
            .map_err(|e| P2pError::Crypto(format!("encryption failed: {e}")))?;

        let nonce_b64 = B64.encode(nonce_bytes);
        let ciphertext_b64 = B64.encode(&ciphertext);
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
        crate::posts::append_dm(&json!({
            "direction": "out", "peer_pubkey": peer.pubkey,
            "peer_fingerprint": peer.fingerprint, "peer_username": peer.username,
            "content": content, "timestamp": payload.timestamp,
        }));
        self.network.send_to_pubkey(&peer.pubkey, WireMessage::DirectMessage(payload)).await
    }

    pub async fn broadcast(&self, content: &str) -> Result<()> {
        let message_id = Uuid::new_v4().to_string();
        let to_sign = format!("{}{}", message_id, content);
        let sig: Signature = { self.identity.read().await.signing_key.sign(to_sign.as_bytes()) };
        let payload = BroadcastPayload {
            message_id,
            sender_pubkey: self.identity.read().await.pubkey_b64(),
            content: content.to_string(),
            signature: B64.encode(sig.to_bytes()),
            timestamp: Utc::now(),
        };
        // Store locally first
        self.post_store.insert(payload.clone()).await;
        self.network.broadcast(WireMessage::Broadcast(payload)).await;
        Ok(())
    }

    pub async fn like_post(&self, post_id: &str) -> Result<usize> {
        let (liker_pubkey, liker_username) = {
            let id = self.identity.read().await;
            (id.pubkey_b64(), id.username.clone())
        };
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
            // Already liked — return current count
            return Ok(self.post_store.get_post(post_id).await.map(|p| p.like_count()).unwrap_or(0));
        }

        // Propagate like to all peers
        self.network.broadcast(WireMessage::Like(like)).await;

        Ok(self.post_store.get_post(post_id).await.map(|p| p.like_count()).unwrap_or(0))
    }

    async fn handle_inbound(&self, msg: WireMessage) {
        match msg {
            WireMessage::DirectMessage(dm) => self.handle_direct(dm).await,
            WireMessage::Broadcast(bc) => self.handle_broadcast(bc).await,
            WireMessage::Like(lk) => self.handle_like(lk).await,
            _ => {}
        }
    }

    async fn handle_direct(&self, dm: DirectMessagePayload) {
        let own_pubkey = self.identity.read().await.pubkey_b64();
        if dm.recipient_pubkey != own_pubkey { return; }
        match self.verify_and_decrypt_dm(&dm).await {
            Ok(content) => {
                let fingerprint = sender_fingerprint(&dm.sender_pubkey);
                let sender_peer = self.dht.get(&dm.sender_pubkey).await;
                let sender_username = sender_peer.as_ref().and_then(|p| p.username.clone());
                let sender_avatar = sender_peer.and_then(|p| p.avatar);
                crate::posts::append_dm(&json!({
                    "direction": "in", "peer_pubkey": dm.sender_pubkey,
                    "peer_fingerprint": fingerprint, "peer_username": sender_username,
                    "content": content, "timestamp": dm.timestamp,
                }));
                if let Some(ref ipc) = self.ipc {
                    ipc.send(crate::types::IpcEvent {
                        event: "message".into(),
                        data: json!({ "kind": "dm", "sender_pubkey": dm.sender_pubkey, "sender_fingerprint": fingerprint, "sender_username": sender_username, "sender_avatar": sender_avatar, "content": content, "timestamp": dm.timestamp }),
                    });
                }
                let _ = self.inbound_tx.send(InboundMessage {
                    kind: InboundKind::Direct { content },
                    sender_pubkey: dm.sender_pubkey,
                    sender_fingerprint: fingerprint,
                    sender_username,
                }).await;
            }
            Err(e) => tracing::warn!("messaging: invalid DM: {}", e),
        }
    }

    async fn handle_broadcast(&self, bc: BroadcastPayload) {
        if let Err(e) = self.verify_broadcast(&bc) {
            tracing::warn!("messaging: invalid broadcast: {}", e);
            return;
        }
        let is_new = self.post_store.insert(bc.clone()).await;
        if !is_new { return; } // already seen, don't re-emit

        let fingerprint = sender_fingerprint(&bc.sender_pubkey);
        let sender_peer = self.dht.get(&bc.sender_pubkey).await;
        let sender_username = sender_peer.as_ref().and_then(|p| p.username.clone());
        let sender_avatar = sender_peer.and_then(|p| p.avatar);

        if let Some(ref ipc) = self.ipc {
            ipc.send(crate::types::IpcEvent {
                event: "message".into(),
                data: json!({ "kind": "broadcast", "post_id": bc.message_id, "sender_pubkey": bc.sender_pubkey, "sender_fingerprint": fingerprint, "sender_username": sender_username, "sender_avatar": sender_avatar, "content": bc.content, "timestamp": bc.timestamp, "like_count": 0 }),
            });
        }

        let _ = self.inbound_tx.send(InboundMessage {
            kind: InboundKind::Broadcast { content: bc.content, post_id: bc.message_id },
            sender_pubkey: bc.sender_pubkey,
            sender_fingerprint: fingerprint,
            sender_username,
        }).await;
    }

    async fn handle_like(&self, lk: LikePayload) {
        // Verify signature
        if let Err(e) = self.verify_like(&lk) {
            tracing::warn!("messaging: invalid like: {}", e);
            return;
        }

        let (is_new, post_author) = self.post_store.add_like(lk.clone()).await;
        if !is_new { return; }

        let like_count = self.post_store.get_post(&lk.post_id).await.map(|p| p.like_count()).unwrap_or(0);
        let own_pubkey = self.identity.read().await.pubkey_b64();

        // Send IPC event: always broadcast updated like count
        if let Some(ref ipc) = self.ipc {
            ipc.send(crate::types::IpcEvent {
                event: "like_update".into(),
                data: json!({ "post_id": lk.post_id, "liker_pubkey": lk.liker_pubkey, "liker_username": lk.liker_username, "like_count": like_count }),
            });

            // If the liked post is ours, also send a notification
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

        // Propagate to all peers so like counts stay consistent
        self.network.broadcast(WireMessage::Like(lk.clone())).await;

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

    async fn verify_and_decrypt_dm(&self, dm: &DirectMessagePayload) -> Result<String> {
        let age = Utc::now().signed_duration_since(dm.timestamp).to_std()
            .unwrap_or(MAX_MSG_AGE + Duration::from_secs(1));
        if age > MAX_MSG_AGE { return Err(P2pError::MessageExpired); }

        let vk = verifying_key_from_b64(&dm.sender_pubkey)?;
        let sig_bytes = B64.decode(&dm.signature).map_err(|_| P2pError::InvalidSignature)?;
        let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| P2pError::InvalidSignature)?;
        vk.verify(format!("{}{}{}", dm.message_id, dm.nonce, dm.ciphertext).as_bytes(),
            &Signature::from_bytes(&sig_arr)).map_err(|_| P2pError::InvalidSignature)?;

        let their_x25519 = x25519_pubkey_for_peer(&dm.sender_pubkey)?;
        let shared_secret = { self.identity.read().await.x25519_secret.diffie_hellman(&their_x25519) };
        let aes_key = hkdf_derive(shared_secret.as_bytes(), HKDF_SALT, dm.message_id.as_bytes());
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&aes_key));
        let nonce_bytes = B64.decode(&dm.nonce).map_err(|_| P2pError::Crypto("bad nonce".into()))?;
        if nonce_bytes.len() != 12 { return Err(P2pError::Crypto("nonce must be 12 bytes".into())); }
        let ciphertext = B64.decode(&dm.ciphertext).map_err(|_| P2pError::Crypto("bad ciphertext".into()))?;
        let plaintext = cipher.decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
            .map_err(|_| P2pError::Crypto("decryption failed".into()))?;
        String::from_utf8(plaintext).map_err(|_| P2pError::Crypto("invalid UTF-8".into()))
    }

    fn verify_broadcast(&self, bc: &BroadcastPayload) -> Result<()> {
        let age = Utc::now().signed_duration_since(bc.timestamp).to_std()
            .unwrap_or(MAX_POST_AGE + Duration::from_secs(1));
        if age > MAX_POST_AGE { return Err(P2pError::MessageExpired); }
        let vk = verifying_key_from_b64(&bc.sender_pubkey)?;
        let sig_bytes = B64.decode(&bc.signature).map_err(|_| P2pError::InvalidSignature)?;
        let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| P2pError::InvalidSignature)?;
        vk.verify(format!("{}{}", bc.message_id, bc.content).as_bytes(),
            &Signature::from_bytes(&sig_arr)).map_err(|_| P2pError::InvalidSignature)
    }

    fn verify_like(&self, lk: &LikePayload) -> Result<()> {
        let vk = verifying_key_from_b64(&lk.liker_pubkey)?;
        let sig_bytes = B64.decode(&lk.signature).map_err(|_| P2pError::InvalidSignature)?;
        let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| P2pError::InvalidSignature)?;
        vk.verify(format!("{}{}", lk.post_id, lk.liker_pubkey).as_bytes(),
            &Signature::from_bytes(&sig_arr)).map_err(|_| P2pError::InvalidSignature)
    }

    async fn resolve_peer(&self, recipient: &str) -> Result<crate::types::Peer> {
        if let Some(peer) = self.dht.get(recipient).await { return Ok(peer); }
        if let Some(peer) = self.dht.get_by_fingerprint(recipient).await { return Ok(peer); }
        Err(P2pError::PeerNotFound(format!("'{}' — use `peers` to list known nodes", recipient)))
    }
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

fn hkdf_derive(secret: &[u8], salt: &[u8], info: &[u8]) -> [u8; 32] {
    let prk = hmac_sha256(salt, secret);
    let mut expand_input = info.to_vec();
    expand_input.push(0x01);
    hmac_sha256(&prk, &expand_input)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    let mut k = [0u8; 64];
    if key.len() > 64 { let h = Sha256::digest(key); k[..32].copy_from_slice(&h); }
    else { k[..key.len()].copy_from_slice(key); }
    let ipad: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    let opad: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    let mut inner = Sha256::new(); inner.update(&ipad); inner.update(data);
    let inner_hash = { use sha2::digest::FixedOutput; inner.finalize_fixed() };
    let mut outer = Sha256::new(); outer.update(&opad); outer.update(inner_hash);
    use sha2::digest::FixedOutput; outer.finalize_fixed().into()
}

fn x25519_pubkey_for_peer(ed25519_pubkey_b64: &str) -> Result<X25519Public> {
    use x25519_dalek::StaticSecret;
    let ed_bytes = B64.decode(ed25519_pubkey_b64).map_err(|_| P2pError::Crypto("bad pubkey base64".into()))?;
    let mut hasher = Sha256::new(); hasher.update(b"agora-x25519-derive-v1"); hasher.update(&ed_bytes);
    let secret_bytes: [u8; 32] = { use sha2::Digest; hasher.finalize().into() };
    Ok(X25519Public::from(&StaticSecret::from(secret_bytes)))
}

fn sender_fingerprint(pubkey_b64: &str) -> String {
    B64.decode(pubkey_b64)
        .map(|b| crate::identity::pubkey_fingerprint(&b))
        .unwrap_or_else(|_| "??:??:??:??:??:??:??:??".into())
}
