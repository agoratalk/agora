//! Network layer: TCP listener, outbound connections, handshake, IPC events.
//!
//! Connection modes:
//!   Raw — direct TCP connection using the local IP address.
//!   Tor — all outbound connections are tunnelled through a SOCKS5 proxy that
//!         must be listening on 127.0.0.1:9050 (standard Tor daemon port).
//!         The Tor process itself must be running separately.

use std::{net::SocketAddr, sync::Arc, time::Duration};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use ed25519_dalek::{Signature, Signer, Verifier};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, RwLock},
    time,
};
use tokio_socks::tcp::Socks5Stream;

use crate::{
    dht::Dht,
    discovery::DiscoveredAddr,
    identity::Identity,
    ipc::IpcBroadcaster,
    posts::PostStore,
    types::{HelloPayload, P2pError, Result, WireMessage},
};

pub const DEFAULT_PORT: u16 = 7777;
/// SOCKS5 port used by the Tor daemon.
const TOR_SOCKS5_PORT: u16 = 9050;
/// SOCKS5 port exposed by the I2P router (Java I2P and i2pd both default to 4447).
const I2P_SOCKS5_PORT: u16 = 4447;

const MAX_MESSAGE_AGE: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FRAME_LEN: u32 = 4 * 1024 * 1024;

/// How outbound TCP connections are established.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnMode {
    /// Direct TCP — exposes the real IP address to peers.
    Raw,
    /// Route every outbound connection through the local Tor SOCKS5 proxy
    /// (`127.0.0.1:9050`).  The Tor process must already be running.
    Tor,
    /// Route every outbound connection through the local I2P SOCKS5 proxy
    /// (`127.0.0.1:4447`).  The I2P router (Java I2P or i2pd) must be
    /// running and have its SOCKS5 tunnel enabled.
    I2p,
}

impl ConnMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnMode::Raw => "raw",
            ConnMode::Tor => "TOR",
            ConnMode::I2p => "i2p",
        }
    }
}

impl std::fmt::Display for ConnMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub type MessageHandler = Arc<
    dyn Fn(WireMessage, SocketAddr) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct Network {
    pub identity: Arc<RwLock<Identity>>,
    dht: Dht,
    port: u16,
    handlers: Arc<RwLock<Vec<MessageHandler>>>,
    active_peers: Arc<RwLock<std::collections::HashSet<String>>>,
    ipc: Option<IpcBroadcaster>,
    post_store: Option<PostStore>,
    pub conn_mode: Arc<RwLock<ConnMode>>,
}

impl Network {
    pub fn new(identity: Arc<RwLock<Identity>>, dht: Dht, port: u16) -> Self {
        Self {
            identity,
            dht,
            port,
            handlers: Arc::new(RwLock::new(Vec::new())),
            active_peers: Arc::new(RwLock::new(std::collections::HashSet::new())),
            ipc: None,
            post_store: None,
            conn_mode: Arc::new(RwLock::new(ConnMode::Raw)),
        }
    }

    /// Switch the active connection mode.  Takes effect for all subsequent
    /// outbound connections; existing connections are not affected.
    pub async fn set_conn_mode(&self, mode: ConnMode) {
        tracing::info!("network: connection mode → {}", mode);
        *self.conn_mode.write().await = mode;
    }

    /// Return a copy of the current connection mode.
    pub async fn get_conn_mode(&self) -> ConnMode {
        self.conn_mode.read().await.clone()
    }

    /// Open an outbound TCP stream according to the current [`ConnMode`].
    ///
    /// * `Raw` — plain `TcpStream::connect`, exposes the real IP.
    /// * `Tor` — SOCKS5 via `127.0.0.1:9050`; requires a running Tor daemon.
    /// * `I2p` — SOCKS5 via `127.0.0.1:4447`; requires a running I2P router
    ///   with its SOCKS5 tunnel enabled (Java I2P and i2pd both default to
    ///   this port).  After the handshake, `into_inner()` gives a plain
    ///   `TcpStream` that is transparently tunnelled through the I2P network.
    async fn open_stream(&self, addr: SocketAddr) -> Result<TcpStream> {
        match *self.conn_mode.read().await {
            ConnMode::Raw => {
                time::timeout(HANDSHAKE_TIMEOUT, TcpStream::connect(addr))
                    .await
                    .map_err(|_| P2pError::Network(std::io::Error::new(
                        std::io::ErrorKind::TimedOut, "connect timed out",
                    )))?
                    .map_err(P2pError::Network)
            }
            ConnMode::Tor => {
                let proxy = SocketAddr::from(([127, 0, 0, 1], TOR_SOCKS5_PORT));
                tracing::debug!("network: routing {} through Tor SOCKS5 proxy", addr);
                let socks = time::timeout(
                    HANDSHAKE_TIMEOUT,
                    Socks5Stream::connect(proxy, addr),
                )
                .await
                .map_err(|_| P2pError::Network(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Tor connect timed out — is the Tor daemon running on port 9050?",
                )))?
                .map_err(|e| P2pError::Network(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("SOCKS5/Tor error: {e}"),
                )))?;
                Ok(socks.into_inner())
            }
            ConnMode::I2p => {
                let proxy = SocketAddr::from(([127, 0, 0, 1], I2P_SOCKS5_PORT));
                tracing::debug!("network: routing {} through I2P SOCKS5 proxy", addr);
                let socks = time::timeout(
                    HANDSHAKE_TIMEOUT,
                    Socks5Stream::connect(proxy, addr),
                )
                .await
                .map_err(|_| P2pError::Network(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "I2P connect timed out — is the I2P router running with SOCKS5 on port 4447?",
                )))?
                .map_err(|e| P2pError::Network(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("SOCKS5/I2P error: {e}"),
                )))?;
                Ok(socks.into_inner())
            }
        }
    }

    pub fn set_post_store(&mut self, ps: PostStore) {
        self.post_store = Some(ps);
    }

    pub fn set_ipc(&mut self, ipc: IpcBroadcaster) {
        self.ipc = Some(ipc);
    }

    pub async fn on_message(&self, handler: MessageHandler) {
        self.handlers.write().await.push(handler);
    }

    pub async fn listen(&self) -> Result<()> {
        let addr = SocketAddr::from(([0, 0, 0, 0], self.port));
        let listener = TcpListener::bind(addr).await?;
        tracing::info!("network: listening on {}", addr);
        let net = self.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, peer_addr)) => {
                        let net2 = net.clone();
                        tokio::spawn(async move {
                            if let Err(e) = net2.handle_connection(stream, peer_addr).await {
                                tracing::warn!("connection from {} error: {}", peer_addr, e);
                            }
                        });
                    }
                    Err(e) => tracing::warn!("accept error: {}", e),
                }
            }
        });
        Ok(())
    }

    pub fn spawn_dialer(&self, mut rx: mpsc::Receiver<DiscoveredAddr>) {
        let net = self.clone();
        tokio::spawn(async move {
            while let Some(discovered) = rx.recv().await {
                let net2 = net.clone();
                tokio::spawn(async move {
                    if let Err(e) = net2.dial(discovered.addr).await {
                        tracing::debug!("dial {} failed: {}", discovered.addr, e);
                    }
                });
            }
        });
    }

    pub async fn dial(&self, addr: SocketAddr) -> Result<()> {
        let stream = self.open_stream(addr).await?;
        tracing::info!("network: outbound connection to {} ({})", addr, self.conn_mode.read().await);
        self.handle_connection(stream, addr).await
    }

    pub async fn send_to_pubkey(&self, pubkey: &str, msg: WireMessage) -> Result<()> {
        let peer = self.dht.get(pubkey).await
            .ok_or_else(|| P2pError::PeerNotFound(pubkey[..8.min(pubkey.len())].to_string()))?;

        let mut stream = self.open_stream(peer.addr).await?;

        let hello = self.build_hello().await?;
        write_frame(&mut stream, &WireMessage::Hello(hello)).await?;
        write_frame(&mut stream, &msg).await?;
        stream.flush().await?;
        // Read and process the server's Hello before closing. The server always
        // writes its Hello first in handle_connection. If we drop the stream
        // with unread data still in our receive buffer, the OS sends a TCP RST
        // instead of a graceful FIN. The server receives that RST and tears
        // down the connection before it has a chance to read our message —
        // causing intermittent DM and broadcast delivery failures. Processing
        // the Hello also lets us pick up gossip and keeps the peer fresh in the
        // DHT so it isn't evicted before the next discovery cycle.
        if let Ok(Ok(WireMessage::Hello(their_hello))) =
            time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut stream)).await
        {
            let sock_addr = SocketAddr::new(peer.addr.ip(), DEFAULT_PORT);
            let _ = self.process_hello(&their_hello, sock_addr).await;
        }
        Ok(())
    }

    pub async fn broadcast(&self, msg: WireMessage) {
        let peers = self.dht.peers().await;
        for peer in peers {
            let msg2 = msg.clone();
            let net = self.clone();
            tokio::spawn(async move {
                if let Err(e) = net.send_to_pubkey(&peer.pubkey, msg2).await {
                    tracing::warn!("broadcast to {} failed: {}", peer.fingerprint, e);
                }
            });
        }
    }

    async fn handle_connection(&self, mut stream: TcpStream, peer_addr: SocketAddr) -> Result<()> {
        let hello = self.build_hello().await?;
        write_frame(&mut stream, &WireMessage::Hello(hello)).await?;

        let their_hello = time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut stream))
            .await
            .map_err(|_| P2pError::Network(std::io::Error::new(std::io::ErrorKind::TimedOut, "handshake timed out")))??;

        let peer_pubkey = match their_hello {
            WireMessage::Hello(ref h) => {
                self.process_hello(h, peer_addr).await?;
                h.sender_pubkey.clone()
            }
            _ => return Err(P2pError::Network(std::io::Error::new(
                std::io::ErrorKind::InvalidData, "expected Hello as first message"
            ))),
        };

        loop {
            match read_frame(&mut stream).await {
                Ok(msg) => {
                    self.dht.touch(&peer_pubkey).await;
                    if let WireMessage::DirectMessage(ref dm) = msg {
                        let ack = WireMessage::Ack { message_id: dm.message_id.clone() };
                        let _ = write_frame(&mut stream, &ack).await;
                    }
                    self.dispatch(msg, peer_addr).await;
                }
                Err(e) => {
                    tracing::debug!("connection to {} closed: {}", peer_addr, e);
                    break;
                }
            }
        }
        Ok(())
    }

    async fn build_hello(&self) -> Result<HelloPayload> {
        let identity = self.identity.read().await;
        let timestamp = Utc::now();
        let sender_pubkey = identity.pubkey_b64();
        let sender_x25519_pubkey = identity.x25519_pubkey_b64();
        let known_peers = self.dht.peers().await;
        let username = identity.username.clone();
        let avatar = identity.avatar.clone();
        let bio = identity.bio.clone();

        let to_sign = format!("{}{}{}", sender_pubkey, sender_x25519_pubkey, timestamp.to_rfc3339());
        let sig: ed25519_dalek::Signature = identity.signing_key.sign(to_sign.as_bytes());

        // Include up to 50 recent posts for 24h propagation
        let recent_posts = if let Some(ref ps) = self.post_store {
            let mut posts = ps.recent_posts().await;
            posts.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            posts.truncate(50);
            posts
        } else { vec![] };

        Ok(HelloPayload {
            sender_pubkey,
            sender_x25519_pubkey,
            known_peers,
            timestamp,
            signature: B64.encode(sig.to_bytes()),
            username,
            avatar,
            bio,
            recent_posts,
        })
    }

    async fn process_hello(&self, hello: &HelloPayload, peer_addr: SocketAddr) -> Result<()> {
        let age = Utc::now()
            .signed_duration_since(hello.timestamp)
            .to_std()
            .unwrap_or(MAX_MESSAGE_AGE + Duration::from_secs(1));
        if age > MAX_MESSAGE_AGE {
            return Err(P2pError::MessageExpired);
        }

        let vk = crate::identity::verifying_key_from_b64(&hello.sender_pubkey)?;
        let sig_bytes = B64.decode(&hello.signature).map_err(|_| P2pError::InvalidSignature)?;
        let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| P2pError::InvalidSignature)?;
        let signature = Signature::from_bytes(&sig_arr);

        let to_verify = format!("{}{}{}", hello.sender_pubkey, hello.sender_x25519_pubkey, hello.timestamp.to_rfc3339());
        vk.verify(to_verify.as_bytes(), &signature).map_err(|_| P2pError::InvalidSignature)?;

        tracing::info!("network: handshake OK with {} @ {}", &hello.sender_pubkey[..8], peer_addr);

        let listen_addr = SocketAddr::new(peer_addr.ip(), DEFAULT_PORT);
        self.dht.upsert(listen_addr, hello.sender_pubkey.clone(), crate::types::DiscoveryMethod::Gossip, hello.username.clone(), hello.avatar.clone(), hello.bio.clone(), Some(hello.sender_x25519_pubkey.clone())).await;
        self.dht.merge_gossip(hello.known_peers.clone()).await;

        // Dispatch any gossiped posts through the message handler so the post
        // store picks them up (messenger.handle_broadcast deduplicates).
        for post in &hello.recent_posts {
            self.dispatch(WireMessage::Broadcast(post.clone()), peer_addr).await;
        }

        // Notify IPC clients that peer list changed.
        if let Some(ref ipc) = self.ipc {
            let peers = self.dht.peers().await;
            let _ = ipc.send(crate::types::IpcEvent {
                event: "peers_updated".into(),
                data: serde_json::to_value(&peers).unwrap_or_default(),
            });
        }

        Ok(())
    }

    async fn dispatch(&self, msg: WireMessage, from: SocketAddr) {
        let handlers = self.handlers.read().await;
        for handler in handlers.iter() {
            handler(msg.clone(), from).await;
        }
    }
}

pub async fn write_frame<W: AsyncWriteExt + Unpin>(writer: &mut W, msg: &WireMessage) -> Result<()> {
    let json = serde_json::to_vec(msg)?;
    let len = json.len() as u32;
    if len > MAX_FRAME_LEN {
        return Err(P2pError::Network(std::io::Error::new(std::io::ErrorKind::InvalidData, "message too large")));
    }
    writer.write_all(&len.to_be_bytes()).await?;
    writer.write_all(&json).await?;
    Ok(())
}

pub async fn read_frame<R: AsyncReadExt + Unpin>(reader: &mut R) -> Result<WireMessage> {
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME_LEN {
        return Err(P2pError::Network(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("frame too large: {} bytes", len))));
    }
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf).await?;
    Ok(serde_json::from_slice(&buf)?)
}
