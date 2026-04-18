//! Network layer: TCP listener, outbound connections, handshake, IPC events.
//!
//! ## Wire framing
//! Every message is length-prefixed: a 4-byte big-endian `u32` followed by
//! that many bytes of JSON.  This lets us use a single persistent TCP
//! connection for multiple sequential messages (send Hello, send DM, etc.)
//! without any ambiguity about message boundaries.
//!
//! ## Connection flow
//!  1. Both sides send a `Hello` immediately after the connection is established.
//!  2. The listener reads the remote Hello, verifies its signature, and inserts
//!     the peer into the DHT.
//!  3. After the handshake, the listener enters a read loop waiting for more
//!     messages.  Most outbound connections are short-lived (send one message
//!     then close), but the listener side can receive arbitrarily many messages.
//!
//! ## Connection modes
//!   Raw — direct TCP connection, exposes the real IP address to peers.
//!   Tor — outbound connections are made through an embedded Tor client (arti).
//!         No external Tor daemon is required; the daemon bootstraps its own
//!         Tor circuits.  Bootstrap takes 10–60 s on first use.
//!   I2p — outbound connections are tunnelled through the local I2P SOCKS5
//!         proxy on 127.0.0.1:4447.  The I2P router must be running.

use std::{net::SocketAddr, sync::Arc, time::Duration};

use arti_client::{TorClient, TorClientConfig};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use ed25519_dalek::{Signature, Signer, Verifier};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, Mutex, RwLock},
    time,
};
use tokio_socks::tcp::Socks5Stream;
use tor_rtcompat::PreferredRuntime;

use crate::{
    dht::Dht,
    discovery::DiscoveredAddr,
    identity::Identity,
    ipc::IpcBroadcaster,
    posts::PostStore,
    types::{HelloPayload, P2pError, Result, WireMessage},
};

/// Default TCP port for peer-to-peer connections.
pub const DEFAULT_PORT: u16 = 7777;
/// SOCKS5 port exposed by the I2P router (Java I2P and i2pd both default to 4447).
const I2P_SOCKS5_PORT: u16 = 4447;

/// Maximum age of a Hello timestamp.  Prevents replaying a captured Hello to
/// impersonate a peer.
const MAX_MESSAGE_AGE: Duration = Duration::from_secs(30);
/// Timeout for the full handshake (Hello exchange) on each new connection.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Tor circuits take longer to build than raw TCP.
const TOR_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
/// Hard cap on incoming frame size to prevent memory exhaustion.
/// 4 MiB is generous for messages that are mostly JSON text.
const MAX_FRAME_LEN: u32 = 4 * 1024 * 1024;

// ── Stream abstraction ────────────────────────────────────────────────────────

/// Combined supertrait so we can erase the concrete stream type (TcpStream,
/// DataStream, etc.) behind a single Box.
/// `Unpin` is required by tokio's `AsyncReadExt`/`AsyncWriteExt` helpers.
pub trait ReadWrite: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ReadWrite for T {}

/// Heap-allocated peer stream, type-erased.
/// Using a trait object lets the same `handle_connection` / `send_to_pubkey`
/// code work regardless of whether the underlying transport is raw TCP, a Tor
/// DataStream, or a SOCKS5-wrapped stream.
pub type PeerStream = Box<dyn ReadWrite>;

// ── ConnMode ──────────────────────────────────────────────────────────────────

/// How outbound TCP connections are established.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnMode {
    /// Direct TCP — exposes the real IP address to peers.
    Raw,
    /// Route every outbound connection through the daemon's own embedded Tor
    /// client (arti).  No external `tor` binary is needed.
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

// ── Network ───────────────────────────────────────────────────────────────────

/// A function that handles an inbound `WireMessage`.
/// `Arc<dyn Fn…>` so it is clone-able and shareable across tasks.
/// The return type is a boxed future because async closures aren't stable yet.
pub type MessageHandler = Arc<
    dyn Fn(WireMessage, SocketAddr) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

/// The network layer — manages the TCP listener, outbound connections, and
/// dispatches inbound messages to registered handlers.
///
/// Clone-able: all fields are cheaply-cloned `Arc` handles so multiple tasks
/// can share the same network state.
#[derive(Clone)]
pub struct Network {
    pub identity: Arc<RwLock<Identity>>,
    dht: Dht,
    port: u16,
    /// List of registered message handlers.  The messenger registers itself
    /// here to receive all inbound wire messages.
    handlers: Arc<RwLock<Vec<MessageHandler>>>,
    /// Set of pubkeys with active outbound connections (prevents duplicates).
    active_peers: Arc<RwLock<std::collections::HashSet<String>>>,
    /// Optional IPC broadcaster for pushing `peers_updated` events.
    ipc: Option<IpcBroadcaster>,
    /// Optional post store — included in Hello payloads for gossip propagation.
    post_store: Option<PostStore>,
    /// Current connection mode (Raw / Tor / I2p).
    pub conn_mode: Arc<RwLock<ConnMode>>,
    /// Embedded Tor client.  None until bootstrap_tor() succeeds.
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
}

impl Network {
    /// Create a new Network with Raw mode and an empty handler list.
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
            tor_client: Arc::new(Mutex::new(None)),
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

    /// Bootstrap the embedded Tor client.  This downloads the Tor consensus,
    /// builds circuits, and stores the ready client for use by open_stream().
    ///
    /// Safe to call multiple times — if a client is already ready it is
    /// reused and this function returns immediately without creating a second
    /// Arti instance (which would fight over the state-file lock).
    ///
    /// A hard 120-second timeout is applied.  Arti's default bootstrap retries
    /// indefinitely; without the timeout the daemon would spin forever in
    /// restricted environments (Docker without internet, corporate firewalls,
    /// etc.) and never send `tor_status: "failed"` to the frontend.
    pub async fn bootstrap_tor(&self) -> Result<()> {
        // Reuse an existing ready client to avoid lock contention on Arti's
        // state files.  A second TorClient::create_bootstrapped() call while
        // the first is still alive triggers "Another process has the lock"
        // warnings and a brief read-only mode on the new instance.
        {
            let guard = self.tor_client.lock().await;
            if guard.is_some() {
                tracing::info!("network: reusing existing Tor client");
                return Ok(());
            }
        }
        tracing::info!("network: starting Tor bootstrap (this may take up to a minute)…");
        let config = TorClientConfig::default();

        const TOR_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(120);
        let client = match time::timeout(TOR_BOOTSTRAP_TIMEOUT, TorClient::create_bootstrapped(config)).await {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => return Err(P2pError::Network(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Tor bootstrap failed: {e}"),
            ))),
            Err(_) => return Err(P2pError::Network(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Tor bootstrap timed out after 120 s — check your internet connection",
            ))),
        };

        *self.tor_client.lock().await = Some(client);
        tracing::info!("network: Tor client ready");
        Ok(())
    }

    /// True if a Tor client has been bootstrapped and is ready for use.
    pub async fn tor_is_ready(&self) -> bool {
        self.tor_client.lock().await.is_some()
    }

    /// Open an outbound stream according to the current ConnMode.
    ///
    /// - Raw: plain `TcpStream::connect` with a handshake timeout.
    /// - Tor: uses the embedded Arti client to build a Tor circuit.
    /// - I2p: SOCKS5 connect through the local I2P router at port 4447.
    async fn open_stream(&self, addr: SocketAddr) -> Result<PeerStream> {
        match *self.conn_mode.read().await {
            ConnMode::Raw => {
                let stream = time::timeout(HANDSHAKE_TIMEOUT, TcpStream::connect(addr))
                    .await
                    .map_err(|_| P2pError::Network(std::io::Error::new(
                        std::io::ErrorKind::TimedOut, "connect timed out",
                    )))?
                    .map_err(P2pError::Network)?;
                Ok(Box::new(stream))
            }
            ConnMode::Tor => {
                // The Tor client must be bootstrapped before we can make connections.
                let guard = self.tor_client.lock().await;
                let tor = guard.as_ref().ok_or_else(|| P2pError::Network(
                    std::io::Error::new(
                        std::io::ErrorKind::NotConnected,
                        "Tor client not ready — bootstrap is still in progress or failed",
                    )
                ))?;
                tracing::debug!("network: routing {} through embedded Tor", addr);
                let stream = time::timeout(
                    TOR_CONNECT_TIMEOUT,
                    tor.connect((addr.ip().to_string(), addr.port())),
                )
                .await
                .map_err(|_| P2pError::Network(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Tor connect timed out",
                )))?
                .map_err(|e| P2pError::Network(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Tor connect error: {e}"),
                )))?;
                Ok(Box::new(stream))
            }
            ConnMode::I2p => {
                // Connect to the target via the I2P SOCKS5 proxy.
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
                Ok(Box::new(socks.into_inner()))
            }
        }
    }

    /// Fetch the current public (exit-node) IP entirely at the application level —
    /// no system Tor daemon, no SOCKS proxy.
    ///
    /// * Raw / VPN modes: plain TCP via the OS stack.  VPN routing is transparent
    ///   so the returned IP already reflects the VPN exit.
    /// * Tor: uses the **embedded** Arti Tor client to open a circuit and make the
    ///   HTTP request through it.  The returned address is the Tor exit-node IP,
    ///   not the user's real IP.  Returns "bootstrapping…" if the client is not
    ///   ready yet.
    ///
    /// Uses `checkip.amazonaws.com:80` — plain HTTP, returns the IP as plain text
    /// with no HTTPS redirect, so no TLS stack is required.
    pub async fn get_public_ip(&self) -> String {
        const HOST: &str = "checkip.amazonaws.com";
        const REQUEST: &str =
            "GET / HTTP/1.1\r\nHost: checkip.amazonaws.com\r\nConnection: close\r\n\r\n";

        /// Extract the IP from a raw HTTP response.  The body is plain text: "1.2.3.4\n".
        /// Splits on the blank line separating headers from body.
        fn parse_ip(buf: &[u8]) -> Option<String> {
            let text = std::str::from_utf8(buf).ok()?;
            let body = if let Some(idx) = text.find("\r\n\r\n") {
                &text[idx + 4..]
            } else {
                text
            };
            let ip = body.trim().to_owned();
            if ip.is_empty() { None } else { Some(ip) }
        }

        match *self.conn_mode.read().await {
            ConnMode::Tor => {
                // All traffic goes through the embedded Arti client — no system Tor needed.
                let guard = self.tor_client.lock().await;
                let Some(tor) = guard.as_ref() else {
                    return "bootstrapping…".to_string();
                };
                match time::timeout(
                    Duration::from_secs(60),
                    tor.connect((HOST, 80u16)),
                )
                .await
                {
                    Ok(Ok(mut stream)) => {
                        if stream.write_all(REQUEST.as_bytes()).await.is_err() {
                            return "circuit error".to_string();
                        }
                        let mut buf = Vec::new();
                        if stream.read_to_end(&mut buf).await.is_err() {
                            return "circuit error".to_string();
                        }
                        parse_ip(&buf).unwrap_or_else(|| "unknown".to_string())
                    }
                    Ok(Err(e)) => {
                        tracing::warn!("get_public_ip Tor connect error: {e}");
                        "circuit error".to_string()
                    }
                    Err(_) => "timed out".to_string(),
                }
            }
            _ => {
                // Raw / I2P / VPN: OS handles the routing.
                let addrs = match tokio::net::lookup_host(format!("{HOST}:80")).await {
                    Ok(a) => a,
                    Err(_) => return "unknown".to_string(),
                };
                for addr in addrs {
                    let stream_res = time::timeout(
                        Duration::from_secs(10),
                        TcpStream::connect(addr),
                    )
                    .await;
                    let mut stream = match stream_res {
                        Ok(Ok(s)) => s,
                        _ => continue,  // try the next resolved address
                    };
                    if stream.write_all(REQUEST.as_bytes()).await.is_err() {
                        continue;
                    }
                    let mut buf = Vec::new();
                    if stream.read_to_end(&mut buf).await.is_err() {
                        continue;
                    }
                    if let Some(ip) = parse_ip(&buf) {
                        return ip;
                    }
                }
                "unknown".to_string()
            }
        }
    }

    /// Attach a `PostStore` so recent posts are included in Hello payloads.
    pub fn set_post_store(&mut self, ps: PostStore) {
        self.post_store = Some(ps);
    }

    /// Attach the IPC broadcaster for pushing `peers_updated` events.
    pub fn set_ipc(&mut self, ipc: IpcBroadcaster) {
        self.ipc = Some(ipc);
    }

    /// Register a message handler.  All handlers are called (in order) for
    /// every inbound message after the handshake.
    pub async fn on_message(&self, handler: MessageHandler) {
        self.handlers.write().await.push(handler);
    }

    /// Start the TCP listener on `0.0.0.0:{port}`.
    /// Inbound connections are handled in spawned tasks so accept() never blocks.
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
                            // Box the stream to erase the TcpStream type.
                            let boxed: PeerStream = Box::new(stream);
                            if let Err(e) = net2.handle_connection(boxed, peer_addr).await {
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

    /// Spawn a task that reads from `rx` and calls `dial()` for each discovered address.
    /// Each dial is spawned independently so a slow dial doesn't block others.
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

    /// Open a connection to `addr`, perform the handshake, and enter the
    /// message-receive loop.
    pub async fn dial(&self, addr: SocketAddr) -> Result<()> {
        let stream = self.open_stream(addr).await?;
        tracing::info!("network: outbound connection to {} ({})", addr, self.conn_mode.read().await);
        self.handle_connection(stream, addr).await
    }

    /// Send a single wire message to the peer with the given pubkey.
    ///
    /// Opens a fresh connection, sends our Hello (so the peer updates their
    /// DHT entry for us), sends the message, then reads the peer's Hello back
    /// before closing.
    ///
    /// **Why we read the Hello back:**
    /// If we close the stream with unread data in our receive buffer, the OS
    /// sends a TCP RST instead of a graceful FIN.  The peer receives that RST
    /// and tears down the connection before reading our message, causing
    /// intermittent delivery failures.  Reading the Hello back also lets us
    /// pick up any gossip the peer has (keeping their DHT entry fresh).
    pub async fn send_to_pubkey(&self, pubkey: &str, msg: WireMessage) -> Result<()> {
        let peer = self.dht.get(pubkey).await
            .ok_or_else(|| P2pError::PeerNotFound(pubkey[..8.min(pubkey.len())].to_string()))?;

        let mut stream = self.open_stream(peer.addr).await?;

        // Send our Hello first so the remote knows who we are.
        let hello = self.build_hello().await?;
        write_frame(&mut stream, &WireMessage::Hello(hello)).await?;
        write_frame(&mut stream, &msg).await?;
        stream.flush().await?;

        // Read and discard the server's Hello to allow a graceful TCP close.
        if let Ok(Ok(WireMessage::Hello(their_hello))) =
            time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut stream)).await
        {
            let sock_addr = SocketAddr::new(peer.addr.ip(), DEFAULT_PORT);
            let _ = self.process_hello(&their_hello, sock_addr).await;
        }
        Ok(())
    }

    /// Fan out a message to all currently-known peers.
    /// Each send is spawned in its own task so a slow peer doesn't block others.
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

    // ── Internal connection handling ──────────────────────────────────────────

    /// Handle a single peer connection (inbound or outbound).
    ///
    /// Protocol:
    ///  1. Send our Hello immediately.
    ///  2. Wait up to `HANDSHAKE_TIMEOUT` for the peer's Hello.
    ///  3. Verify the Hello signature and insert/update the peer in the DHT.
    ///  4. Loop: read frames, touch the peer's `last_seen`, dispatch to handlers.
    async fn handle_connection(&self, mut stream: PeerStream, peer_addr: SocketAddr) -> Result<()> {
        // Step 1: Send our Hello.
        let hello = self.build_hello().await?;
        write_frame(&mut stream, &WireMessage::Hello(hello)).await?;

        // Step 2: Receive the peer's Hello with a timeout.
        let their_hello = time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut stream))
            .await
            .map_err(|_| P2pError::Network(std::io::Error::new(std::io::ErrorKind::TimedOut, "handshake timed out")))??;

        // Step 3: Verify and process the Hello.
        let peer_pubkey = match their_hello {
            WireMessage::Hello(ref h) => {
                self.process_hello(h, peer_addr).await?;
                h.sender_pubkey.clone()
            }
            _ => return Err(P2pError::Network(std::io::Error::new(
                std::io::ErrorKind::InvalidData, "expected Hello as first message"
            ))),
        };

        // Step 4: Message receive loop.
        loop {
            match read_frame(&mut stream).await {
                Ok(msg) => {
                    // Update last_seen so this peer isn't evicted while we're talking.
                    self.dht.touch(&peer_pubkey).await;
                    // For DMs: send an Ack so the sender knows the frame was received.
                    if let WireMessage::DirectMessage(ref dm) = msg {
                        let ack = WireMessage::Ack { message_id: dm.message_id.clone() };
                        let _ = write_frame(&mut stream, &ack).await;
                    }
                    // Dispatch to all registered handlers (e.g. the Messenger).
                    self.dispatch(msg, peer_addr).await;
                }
                Err(e) => {
                    tracing::debug!("connection to {} closed: {}", peer_addr, e);
                    break;  // EOF or read error — peer disconnected
                }
            }
        }
        Ok(())
    }

    /// Build a Hello payload for the current identity.
    ///
    /// Includes:
    ///  - Our Ed25519 public key and X25519 public key.
    ///  - A timestamp + signature (so the receiver can verify freshness and
    ///    that the Hello is genuine).
    ///  - Our known peer list (for gossip propagation).
    ///  - Up to 50 recent posts and 200 recent comments (24h gossip window).
    ///  - Our username, avatar, and bio.
    async fn build_hello(&self) -> Result<HelloPayload> {
        let identity = self.identity.read().await;
        let timestamp = Utc::now();
        let sender_pubkey = identity.pubkey_b64();
        let sender_x25519_pubkey = identity.x25519_pubkey_b64();
        let known_peers = self.dht.peers().await;
        let username = identity.username.clone();
        let avatar = identity.avatar.clone();
        let bio = identity.bio.clone();

        // Sign (pubkey || x25519_pubkey || timestamp) so the receiver can verify
        // the Hello is genuine and freshly created.
        let to_sign = format!("{}{}{}", sender_pubkey, sender_x25519_pubkey, timestamp.to_rfc3339());
        let sig: ed25519_dalek::Signature = identity.signing_key.sign(to_sign.as_bytes());

        // Include recent posts, comments, and all associated likes for 24h propagation
        let (recent_posts, recent_comments, recent_likes, recent_comment_likes) = if let Some(ref ps) = self.post_store {
            let mut posts = ps.recent_posts().await;
            posts.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            posts.truncate(50);
            let mut comments = ps.recent_comments().await;
            comments.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            comments.truncate(200);
            let mut likes = ps.recent_likes().await;
            likes.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            likes.truncate(500);
            let mut comment_likes = ps.recent_comment_likes().await;
            comment_likes.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            comment_likes.truncate(500);
            (posts, comments, likes, comment_likes)
        } else { (vec![], vec![], vec![], vec![]) };

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
            recent_comments,
            recent_likes,
            recent_comment_likes,
        })
    }

    /// Process an inbound Hello payload.
    ///
    ///  1. Reject Hellos with stale timestamps (anti-replay).
    ///  2. Verify the Ed25519 signature.
    ///  3. Upsert the sender into the DHT (updates address + profile data).
    ///  4. Merge the sender's known-peers list into our DHT (gossip).
    ///  5. Dispatch any gossiped posts and comments through the message handler
    ///     so the post store picks them up.
    ///  6. Notify IPC clients that the peer list changed.
    async fn process_hello(&self, hello: &HelloPayload, peer_addr: SocketAddr) -> Result<()> {
        // Check timestamp freshness.
        let age = Utc::now()
            .signed_duration_since(hello.timestamp)
            .to_std()
            .unwrap_or(MAX_MESSAGE_AGE + Duration::from_secs(1));
        if age > MAX_MESSAGE_AGE {
            return Err(P2pError::MessageExpired);
        }

        // Verify Ed25519 signature.
        let vk = crate::identity::verifying_key_from_b64(&hello.sender_pubkey)?;
        let sig_bytes = B64.decode(&hello.signature).map_err(|_| P2pError::InvalidSignature)?;
        let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| P2pError::InvalidSignature)?;
        let signature = Signature::from_bytes(&sig_arr);

        let to_verify = format!("{}{}{}", hello.sender_pubkey, hello.sender_x25519_pubkey, hello.timestamp.to_rfc3339());
        vk.verify(to_verify.as_bytes(), &signature).map_err(|_| P2pError::InvalidSignature)?;

        tracing::info!("network: handshake OK with {} @ {}", &hello.sender_pubkey[..8], peer_addr);

        // Use DEFAULT_PORT for the peer's listen address, not the ephemeral
        // source port on the incoming connection.
        let listen_addr = SocketAddr::new(peer_addr.ip(), DEFAULT_PORT);
        self.dht.upsert(listen_addr, hello.sender_pubkey.clone(), crate::types::DiscoveryMethod::Gossip, hello.username.clone(), hello.avatar.clone(), hello.bio.clone(), Some(hello.sender_x25519_pubkey.clone())).await;
        // Merge the sender's peer list into ours (network-wide gossip).
        self.dht.merge_gossip(hello.known_peers.clone()).await;

        // Dispatch gossiped posts through the message handler so the post
        // store picks them up (messenger.handle_broadcast deduplicates them).
        for post in &hello.recent_posts {
            self.dispatch(WireMessage::Broadcast(post.clone()), peer_addr).await;
        }
        // Dispatch gossiped comments similarly.
        for comment in &hello.recent_comments {
            self.dispatch(WireMessage::Comment(comment.clone()), peer_addr).await;
        }
        // Dispatch gossiped likes and comment likes so the store records them.
        for like in &hello.recent_likes {
            self.dispatch(WireMessage::Like(like.clone()), peer_addr).await;
        }
        for cl in &hello.recent_comment_likes {
            self.dispatch(WireMessage::CommentLike(cl.clone()), peer_addr).await;
        }

        // Notify IPC clients that peer list changed so the front-end updates.
        if let Some(ref ipc) = self.ipc {
            let peers = self.dht.peers().await;
            let _ = ipc.send(crate::types::IpcEvent {
                event: "peers_updated".into(),
                data: serde_json::to_value(&peers).unwrap_or_default(),
            });
        }

        Ok(())
    }

    /// Call all registered message handlers for a given inbound message.
    async fn dispatch(&self, msg: WireMessage, from: SocketAddr) {
        let handlers = self.handlers.read().await;
        for handler in handlers.iter() {
            handler(msg.clone(), from).await;
        }
    }
}

// ── Wire framing ──────────────────────────────────────────────────────────────

/// Serialise `msg` to JSON and write it as a length-prefixed frame.
///
/// Frame format: `[4-byte big-endian length][JSON bytes]`
///
/// The length prefix lets the reader know exactly how many bytes to read
/// for the next message without needing a delimiter.
pub async fn write_frame<W: AsyncWriteExt + Unpin>(writer: &mut W, msg: &WireMessage) -> Result<()> {
    let json = serde_json::to_vec(msg)?;
    let len = json.len() as u32;
    if len > MAX_FRAME_LEN {
        return Err(P2pError::Network(std::io::Error::new(std::io::ErrorKind::InvalidData, "message too large")));
    }
    // Write the 4-byte length header, then the JSON body.
    writer.write_all(&len.to_be_bytes()).await?;
    writer.write_all(&json).await?;
    Ok(())
}

/// Read a single length-prefixed frame from `reader` and deserialise it.
///
/// Reads 4 bytes for the length, then exactly that many bytes for the body.
/// Returns an error if the frame is larger than `MAX_FRAME_LEN` (to prevent
/// memory exhaustion from a malicious peer sending a huge length value).
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
