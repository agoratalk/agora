//! IPC server: local TCP on port 7779.
//!
//! Methods:
//!   whoami                 → { pubkey, fingerprint, username, account_name }
//!   peers                  → [Peer, ...]
//!   send_dm                → params: { recipient, content, image? }
//!   broadcast              → params: { content, image? }
//!   like_post              → params: { post_id }  → { like_count }
//!   posts                  → [] of { post_id, sender_pubkey, sender_fingerprint, content, image?, timestamp, like_count, likes }
//!   set_username           → params: { username }
//!   connect                → params: { addr }
//!   list_identities        → [IdentitySummary, ...]
//!   switch_identity        → params: { account_name }  (restarts daemon internals)
//!   create_identity        → params: { account_name, username? }
//!   delete_identity        → params: { account_name }
//!   set_avatar             → params: { avatar }  (base64 data URL, or null to clear)
//!   set_bio                → params: { bio }  (string ≤500 chars, or null to clear)

use std::{net::SocketAddr, sync::Arc};

use base64::Engine;
use serde_json::json;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::{broadcast, RwLock},
};

use crate::{
    dht::Dht,
    identity::{Identity, IdentitySummary},
    messaging::Messenger,
    network::{ConnMode, Network},
    types::{IpcEvent, IpcRequest, IpcResponse},
};

pub const DEFAULT_IPC_PORT: u16 = 7779;

#[derive(Clone)]
pub struct IpcBroadcaster {
    tx: broadcast::Sender<IpcEvent>,
}

impl IpcBroadcaster {
    pub fn send(&self, event: IpcEvent) -> bool { self.tx.send(event).is_ok() }
}

pub struct IpcServer {
    port: u16,
    identity: Arc<RwLock<Identity>>,
    dht: Dht,
    messenger: Messenger,
    network: Network,
    broadcaster: IpcBroadcaster,
    event_rx: broadcast::Receiver<IpcEvent>,
}

impl IpcServer {
    pub fn new(port: u16, identity: Arc<RwLock<Identity>>, dht: Dht, messenger: Messenger, network: Network) -> (Self, IpcBroadcaster) {
        let (tx, event_rx) = broadcast::channel(256);
        let broadcaster = IpcBroadcaster { tx };
        let server = Self { port, identity, dht, messenger, network, broadcaster: broadcaster.clone(), event_rx };
        (server, broadcaster)
    }

    pub async fn listen(self) {
        let addr = SocketAddr::from(([127, 0, 0, 1], self.port));
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => { tracing::info!("IPC: listening on {}", addr); l }
            Err(e) => { tracing::error!("IPC: failed to bind {}: {}", addr, e); return; }
        };
        let server = Arc::new(self);
        loop {
            match listener.accept().await {
                Ok((stream, _)) => { let s = server.clone(); tokio::spawn(async move { s.handle_client(stream).await; }); }
                Err(e) => tracing::warn!("IPC accept error: {}", e),
            }
        }
    }

    async fn handle_client(self: Arc<Self>, stream: tokio::net::TcpStream) {
        let (read_half, mut write_half) = stream.into_split();
        let mut lines = BufReader::new(read_half).lines();
        let mut events = self.broadcaster.tx.subscribe();
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    match line {
                        Ok(Some(raw)) => {
                            let resp = self.handle_request(&raw).await;
                            let mut out = serde_json::to_string(&resp).unwrap_or_default();
                            out.push('\n');
                            if write_half.write_all(out.as_bytes()).await.is_err() { break; }
                        }
                        _ => break,
                    }
                }
                event = events.recv() => {
                    if let Ok(ev) = event {
                        let mut out = serde_json::to_string(&ev).unwrap_or_default();
                        out.push('\n');
                        if write_half.write_all(out.as_bytes()).await.is_err() { break; }
                    }
                }
            }
        }
    }

    async fn handle_request(&self, raw: &str) -> IpcResponse {
        let req: IpcRequest = match serde_json::from_str(raw) {
            Ok(r) => r,
            Err(e) => return IpcResponse { id: 0, result: None, error: Some(format!("parse error: {e}")) },
        };
        let id = req.id;

        match req.method.as_str() {
            "whoami" => {
                let identity = self.identity.read().await;
                IpcResponse { id, result: Some(json!({
                    "pubkey": identity.pubkey_b64(),
                    "fingerprint": identity.fingerprint(),
                    "username": identity.username,
                    "account_name": identity.account_name,
                    "avatar": identity.avatar,
                    "bio": identity.bio,
                })), error: None }
            }
            "peers" => {
                let peers = self.dht.peers().await;
                IpcResponse { id, result: Some(serde_json::to_value(&peers).unwrap_or_default()), error: None }
            }
            "send_dm" => {
                let recipient = req.params.get("recipient").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let content = req.params.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let image = req.params.get("image").and_then(|v| v.as_str()).map(|s| s.to_string());
                if let Some(ref img) = image {
                    let allowed = ["data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,"];
                    if !allowed.iter().any(|prefix| img.starts_with(prefix)) {
                        return IpcResponse { id, result: None, error: Some("image must be a JPEG, PNG, or WebP data URL".into()) };
                    }
                }
                match self.messenger.send_direct(&recipient, &content, image.as_deref()).await {
                    Ok(()) => IpcResponse { id, result: Some(json!({"ok": true})), error: None },
                    Err(e) => IpcResponse { id, result: None, error: Some(e.to_string()) },
                }
            }
            "broadcast" => {
                let content = req.params.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let image = req.params.get("image").and_then(|v| v.as_str()).map(|s| s.to_string());
                let embed_url = req.params.get("embed_url").and_then(|v| v.as_str()).map(|s| s.to_string());
                if let Some(ref img) = image {
                    let allowed = ["data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,"];
                    if !allowed.iter().any(|prefix| img.starts_with(prefix)) {
                        return IpcResponse { id, result: None, error: Some("image must be a JPEG, PNG, or WebP data URL".into()) };
                    }
                }
                if let Some(ref url) = embed_url {
                    let allowed_domains = ["youtube.com", "youtu.be", "twitter.com", "x.com", "open.spotify.com", "soundcloud.com", "vimeo.com"];
                    let is_valid = url.starts_with("https://") && {
                        let without_scheme = &url[8..];
                        let domain_end = without_scheme.find('/').unwrap_or(without_scheme.len());
                        let domain = without_scheme[..domain_end].trim_start_matches("www.");
                        allowed_domains.iter().any(|d| domain == *d)
                    };
                    if !is_valid {
                        return IpcResponse { id, result: None, error: Some("embed_url must be an https URL from a supported platform (YouTube, Twitter/X, Spotify, SoundCloud, Vimeo)".into()) };
                    }
                }
                match self.messenger.broadcast(&content, image.as_deref(), embed_url.as_deref()).await {
                    Ok(()) => IpcResponse { id, result: Some(json!({"ok": true})), error: None },
                    Err(e) => IpcResponse { id, result: None, error: Some(e.to_string()) },
                }
            }
            "like_post" => {
                let post_id = req.params.get("post_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if post_id.is_empty() {
                    return IpcResponse { id, result: None, error: Some("post_id required".into()) };
                }
                match self.messenger.like_post(&post_id).await {
                    Ok(count) => IpcResponse { id, result: Some(json!({"ok": true, "like_count": count})), error: None },
                    Err(e) => IpcResponse { id, result: None, error: Some(e.to_string()) },
                }
            }
            "dm_history" => {
                let peer_filter = req.params.get("peer_pubkey").and_then(|v| v.as_str()).map(|s| s.to_string());
                let limit = req.params.get("limit").and_then(|v| v.as_u64()).unwrap_or(500) as usize;
                let path = crate::posts::default_dms_path();
                let mut out: Vec<serde_json::Value> = Vec::new();
                if let Ok(text) = std::fs::read_to_string(&path) {
                    for line in text.lines() {
                        if line.trim().is_empty() { continue; }
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                            if let Some(ref pk) = peer_filter {
                                if v.get("peer_pubkey").and_then(|x| x.as_str()) != Some(pk.as_str()) { continue; }
                            }
                            out.push(v);
                        }
                    }
                }
                if out.len() > limit { let skip = out.len() - limit; out = out.split_off(skip); }
                IpcResponse { id, result: Some(json!(out)), error: None }
            }
            "posts" => {
                let mut posts = self.messenger.post_store().all_posts().await;
                posts.sort_by(|a, b| b.payload.timestamp.cmp(&a.payload.timestamp));
                let (own_pubkey, own_username, own_avatar) = {
                    let id = self.identity.read().await;
                    (id.pubkey_b64(), id.username.clone(), id.avatar.clone())
                };
                let mut value: Vec<serde_json::Value> = Vec::with_capacity(posts.len());
                for p in &posts {
                    let fp = crate::identity::pubkey_fingerprint(
                        &base64::engine::general_purpose::STANDARD.decode(&p.payload.sender_pubkey).unwrap_or_default()
                    );
                    let is_own = p.payload.sender_pubkey == own_pubkey;
                    let (sender_username, sender_avatar) = if is_own {
                        (own_username.clone(), own_avatar.clone())
                    } else {
                        let peer = self.dht.get(&p.payload.sender_pubkey).await;
                        (peer.as_ref().and_then(|p| p.username.clone()), peer.and_then(|p| p.avatar))
                    };
                    value.push(json!({
                        "post_id": p.payload.message_id,
                        "sender_pubkey": p.payload.sender_pubkey,
                        "sender_fingerprint": fp,
                        "sender_username": sender_username,
                        "sender_avatar": sender_avatar,
                        "content": p.payload.content,
                        "image": p.payload.image,
                        "embed_url": p.payload.embed_url,
                        "timestamp": p.payload.timestamp,
                        "like_count": p.like_count(),
                        "likes": p.likes,
                        "is_own": is_own,
                    }));
                }
                IpcResponse { id, result: Some(json!(value)), error: None }
            }
            "set_username" => {
                let username = req.params.get("username").and_then(|v| v.as_str()).map(|s| s.to_string());
                {
                    let mut identity = self.identity.write().await;
                    identity.username = username.clone();
                    if let Err(e) = identity.save_to_file() {
                        return IpcResponse { id, result: None, error: Some(e.to_string()) };
                    }
                }
                self.broadcaster.send(IpcEvent { event: "username_changed".into(), data: json!({ "username": username }) });
                IpcResponse { id, result: Some(json!({"ok": true, "username": username})), error: None }
            }
            "set_avatar" => {
                // avatar param is either a base64 data URL string or null/missing to clear
                let avatar = match req.params.get("avatar") {
                    Some(v) if v.is_string() => v.as_str().map(|s| s.to_string()),
                    _ => None,
                };
                // Reject data URLs whose media type is not jpeg, png, or webp
                if let Some(ref data_url) = avatar {
                    let allowed = ["data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,"];
                    if !allowed.iter().any(|prefix| data_url.starts_with(prefix)) {
                        return IpcResponse { id, result: None, error: Some("avatar must be a JPEG, PNG, or WebP image".into()) };
                    }
                }
                {
                    let mut identity = self.identity.write().await;
                    identity.avatar = avatar.clone();
                    if let Err(e) = identity.save_to_file() {
                        return IpcResponse { id, result: None, error: Some(e.to_string()) };
                    }
                }
                self.broadcaster.send(IpcEvent { event: "avatar_changed".into(), data: json!({ "avatar": avatar }) });
                IpcResponse { id, result: Some(json!({"ok": true})), error: None }
            }
            "set_bio" => {
                let bio = match req.params.get("bio") {
                    Some(v) if v.is_string() => v.as_str().map(|s| {
                        // Server-side truncate to 500 chars for safety
                        let s = s.trim();
                        if s.chars().count() > 500 { s.chars().take(500).collect() } else { s.to_string() }
                    }),
                    _ => None,
                };
                {
                    let mut identity = self.identity.write().await;
                    identity.bio = bio.clone();
                    if let Err(e) = identity.save_to_file() {
                        return IpcResponse { id, result: None, error: Some(e.to_string()) };
                    }
                }
                self.broadcaster.send(IpcEvent { event: "bio_changed".into(), data: json!({ "bio": bio }) });
                IpcResponse { id, result: Some(json!({"ok": true})), error: None }
            }
            "connect" => {
                let addr_str = req.params.get("addr").and_then(|v| v.as_str()).unwrap_or("").to_string();
                use std::net::ToSocketAddrs;
                match addr_str.to_socket_addrs() {
                    Ok(mut iter) => {
                        if let Some(addr) = iter.next() {
                            let net = self.network.clone();
                            tokio::spawn(async move { let _ = net.dial(addr).await; });
                            IpcResponse { id, result: Some(json!({"ok": true})), error: None }
                        } else {
                            IpcResponse { id, result: None, error: Some("could not resolve address".into()) }
                        }
                    }
                    Err(e) => IpcResponse { id, result: None, error: Some(e.to_string()) },
                }
            }
            "list_identities" => {
                match Identity::list_identities() {
                    Ok(list) => IpcResponse { id, result: Some(serde_json::to_value(&list).unwrap_or_default()), error: None },
                    Err(e) => IpcResponse { id, result: None, error: Some(e.to_string()) },
                }
            }
            "create_identity" => {
                let account_name = req.params.get("account_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let username = req.params.get("username").and_then(|v| v.as_str()).map(|s| s.to_string());
                if account_name.is_empty() {
                    return IpcResponse { id, result: None, error: Some("account_name required".into()) };
                }
                match Identity::load_or_create_named(&account_name) {
                    Ok(mut new_id) => {
                        new_id.username = username;
                        if let Err(e) = new_id.save_to_file() {
                            return IpcResponse { id, result: None, error: Some(e.to_string()) };
                        }
                        let summary = IdentitySummary {
                            account_name: new_id.account_name.clone(),
                            username: new_id.username.clone(),
                            fingerprint: new_id.fingerprint(),
                            pubkey: new_id.pubkey_b64(),
                            is_active: false,
                            avatar: new_id.avatar.clone(),
                            bio: new_id.bio.clone(),
                        };
                        IpcResponse { id, result: Some(serde_json::to_value(&summary).unwrap_or_default()), error: None }
                    }
                    Err(e) => IpcResponse { id, result: None, error: Some(e.to_string()) },
                }
            }
            "switch_identity" => {
                let account_name = req.params.get("account_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if account_name.is_empty() {
                    return IpcResponse { id, result: None, error: Some("account_name required".into()) };
                }
                match Identity::switch_to(&account_name) {
                    Ok(new_id) => {
                        // Update the shared identity in place
                        let mut identity = self.identity.write().await;
                        identity.signing_key = new_id.signing_key;
                        identity.verifying_key = new_id.verifying_key;
                        identity.x25519_secret = new_id.x25519_secret;
                        identity.x25519_public = new_id.x25519_public;
                        identity.username = new_id.username.clone();
                        identity.account_name = new_id.account_name.clone();
                        identity.avatar = new_id.avatar.clone();
                        drop(identity);
                        self.broadcaster.send(IpcEvent {
                            event: "identity_switched".into(),
                            data: json!({ "account_name": &account_name, "username": new_id.username }),
                        });
                        IpcResponse { id, result: Some(json!({"ok": true, "account_name": account_name})), error: None }
                    }
                    Err(e) => IpcResponse { id, result: None, error: Some(e.to_string()) },
                }
            }
            "delete_identity" => {
                let account_name = req.params.get("account_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                match Identity::delete_named(&account_name) {
                    Ok(()) => IpcResponse { id, result: Some(json!({"ok": true})), error: None },
                    Err(e) => IpcResponse { id, result: None, error: Some(e.to_string()) },
                }
            }
            // ── Connection mode ──────────────────────────────────────────────
            //
            // "set_conn_type" switches how the daemon makes outbound TCP
            // connections.
            //   • "raw"        — direct TCP (default)
            //   • "TOR"        — SOCKS5 via 127.0.0.1:9050 (Tor daemon)
            //   • "i2p"        — SOCKS5 via 127.0.0.1:4447 (I2P router)
            //   • everything else (WireGuard, OpenVPN, nym, QUIC) — accepted
            //     without error; the OS VPN tunnel makes them transparent so
            //     the daemon still uses raw TCP and the routing is handled
            //     at the network layer.
            "set_conn_type" => {
                let type_str = req.params
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("raw");
                let mode = match type_str {
                    "TOR" | "tor" | "Tor" => ConnMode::Tor,
                    "i2p" | "I2P" | "I2p" => ConnMode::I2p,
                    _                      => ConnMode::Raw,
                };
                self.network.set_conn_mode(mode).await;
                IpcResponse { id, result: Some(json!({ "ok": true, "type": type_str })), error: None }
            }
            "get_conn_type" => {
                let type_str = self.network.get_conn_mode().await.as_str();
                IpcResponse { id, result: Some(json!({ "type": type_str })), error: None }
            }

            other => IpcResponse { id, result: None, error: Some(format!("unknown method: {other}")) },
        }
    }
}
