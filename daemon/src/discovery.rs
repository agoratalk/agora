//! Peer discovery: mDNS first, raw subnet scan as fallback.
//!
//! Strategy on startup (and every `SCAN_INTERVAL`):
//!  1. Broadcast our presence over mDNS and collect responses for
//!     `MDNS_WINDOW` seconds.
//!  2. If zero peers were found via mDNS, run a TCP connect sweep across the
//!     local subnet on our application port.
//!  3. Every newly discovered address is handed to the `Network` layer which
//!     performs a handshake and inserts the peer into the DHT.
//!
//! The `Discoverer` struct holds no state of its own — it works exclusively
//! through the shared `Dht` and an async callback channel.

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use mdns_sd::{IfKind, ServiceDaemon, ServiceEvent, ServiceInfo};
use tokio::{sync::mpsc, time};

use crate::{
    dht::Dht,
    types::DiscoveryMethod,
};

// ── Constants ─────────────────────────────────────────────────────────────────

/// mDNS service type advertised and queried.
/// Must end with `.local.` (the mDNS local domain) for mdns-sd to accept it.
const SERVICE_TYPE: &str = "_agora._tcp.local.";

/// How long we listen for mDNS responses before declaring "no peers found".
/// 4 seconds is enough for most LAN environments where mDNS replies arrive
/// within a few hundred milliseconds.
const MDNS_WINDOW: Duration = Duration::from_secs(4);

/// Timeout for each TCP connect probe in the subnet scan.
/// 300 ms keeps the sweep fast while still catching hosts that are slow to
/// respond (e.g. behind a firewall that sends RST after a short delay).
const SCAN_CONNECT_TIMEOUT: Duration = Duration::from_millis(300);

/// How many hosts to probe concurrently during subnet scan.
/// 64 is a balance between speed and not exhausting the OS file descriptor
/// limit (a /24 has 253 hosts, so 4 rounds of 64).
const SCAN_CONCURRENCY: usize = 64;

/// How often the discovery cycle repeats while the daemon is running.
/// Bootstrap nodes are re-dialled every cycle so we reconnect if they restart.
pub const SCAN_INTERVAL: Duration = Duration::from_secs(60);

// ── Public API ────────────────────────────────────────────────────────────────

/// A discovered address that needs a handshake.
/// Sent over a channel to `Network` so discovery and networking are decoupled.
#[derive(Debug, Clone)]
pub struct DiscoveredAddr {
    pub addr: SocketAddr,
    pub method: DiscoveryMethod,
}

/// Owns the mDNS daemon handle and drives the discovery cycle.
pub struct Discoverer {
    /// TCP port this node listens on (same port we probe on neighbours).
    port: u16,
    /// Our own Ed25519 public key in base64.  Used to filter our own mDNS
    /// advertisement out of the results.
    own_pubkey: String,
    /// Sends newly found addresses to the network layer for handshaking.
    tx: mpsc::Sender<DiscoveredAddr>,
    /// Reference to the shared peer table, used to skip already-known peers
    /// during the subnet scan.
    dht: Dht,
    /// Bootstrap node addresses supplied via CLI or config.
    bootstrap_addrs: Vec<SocketAddr>,
    /// When true the node is using an anonymising transport (Tor, I2P).
    /// LAN discovery (mDNS advertisement + subnet scan) is suppressed so the
    /// real IP address is never broadcast to neighbours.
    privacy_mode: AtomicBool,
}

impl Discoverer {
    pub fn new(
        port: u16,
        own_pubkey: String,
        tx: mpsc::Sender<DiscoveredAddr>,
        dht: Dht,
    ) -> Self {
        Self { port, own_pubkey, tx, dht, bootstrap_addrs: Vec::new(), privacy_mode: AtomicBool::new(false) }
    }

    /// Enable or disable privacy mode.  Must be called before `spawn_periodic`.
    /// When true, mDNS advertisement and subnet scanning are suppressed — only
    /// bootstrap nodes are dialled.  Intended for Tor / I2P users who must not
    /// broadcast their real LAN IP address to neighbours.
    pub fn set_private(&self, private: bool) {
        self.privacy_mode.store(private, Ordering::Relaxed);
    }

    /// Add bootstrap node addresses that will be dialled on startup and
    /// periodically re-tried. Accepts `"host:port"` strings; invalid entries
    /// are logged and skipped.
    pub fn add_bootstrap_addrs(&mut self, addrs: &[String]) {
        use std::net::ToSocketAddrs;
        for raw in addrs {
            match raw.to_socket_addrs() {
                Ok(mut iter) => {
                    if let Some(addr) = iter.next() {
                        tracing::info!("bootstrap: registered {} -> {}", raw, addr);
                        self.bootstrap_addrs.push(addr);
                    }
                }
                Err(e) => {
                    tracing::warn!("bootstrap: could not resolve '{}': {}", raw, e);
                }
            }
        }
    }

    /// Dial all configured bootstrap nodes immediately.
    /// Each address is sent as a `DiscoveredAddr` with `Bootstrap` method so
    /// the network layer performs a full handshake + gossip exchange.
    pub async fn dial_bootstrap_nodes(&self) {
        if self.bootstrap_addrs.is_empty() {
            return;
        }
        tracing::info!(
            "bootstrap: dialling {} bootstrap node(s)",
            self.bootstrap_addrs.len()
        );
        for &addr in &self.bootstrap_addrs {
            if self
                .tx
                .send(DiscoveredAddr { addr, method: DiscoveryMethod::Bootstrap })
                .await
                .is_err()
            {
                tracing::warn!("bootstrap: channel closed, aborting");
                return;
            }
        }
    }

    /// Run one full discovery cycle (mDNS → optional subnet scan).
    /// Returns the number of new candidate addresses sent to the network layer.
    pub async fn run_once(&self) -> usize {
        tracing::info!("discovery: starting mDNS scan");
        let mdns_found = self.scan_mdns().await;

        if mdns_found > 0 {
            tracing::info!("discovery: mDNS found {} candidate(s)", mdns_found);
            return mdns_found;
        }

        // mDNS found nothing (no other agora nodes on this LAN, or mDNS is
        // blocked by the network).  Fall back to a raw TCP connect sweep of
        // the /24 subnet.
        tracing::info!("discovery: mDNS found nothing — falling back to subnet scan");
        let subnet_found = self.scan_subnet().await;
        tracing::info!("discovery: subnet scan found {} candidate(s)", subnet_found);
        subnet_found
    }

    /// Spawn a background task that re-runs discovery every `SCAN_INTERVAL`.
    /// Bootstrap nodes are re-dialled each cycle so we reconnect if they restart.
    ///
    /// When privacy mode is active (Tor / I2P), mDNS and subnet scanning are
    /// skipped — only bootstrap nodes are dialled so the real IP stays hidden.
    pub fn spawn_periodic(self: Arc<Self>) {
        let private = self.privacy_mode.load(Ordering::Relaxed);
        if private {
            tracing::info!("discovery: privacy mode — LAN scan suppressed, bootstrap only");
        }
        tokio::spawn(async move {
            // Bootstrap dial runs first so internet peers are ready before
            // local mDNS/subnet scan completes.
            self.dial_bootstrap_nodes().await;
            if !private {
                self.run_once().await;
            }

            let mut ticker = time::interval(SCAN_INTERVAL);
            ticker.tick().await; // consume the first immediate tick so we don't scan twice
            loop {
                ticker.tick().await;
                self.dial_bootstrap_nodes().await;
                if !private {
                    tracing::info!("discovery: periodic re-scan");
                    self.run_once().await;
                }
            }
        });
    }

    // ── mDNS ──────────────────────────────────────────────────────────────────

    /// Run the mDNS scan on a blocking thread.
    /// mdns-sd uses its own internal threads for I/O, so we must call it from
    /// a context that can block.  `spawn_blocking` moves it off the async
    /// executor thread pool.
    async fn scan_mdns(&self) -> usize {
        let port = self.port;
        let own_pubkey = self.own_pubkey.clone();
        let tx = self.tx.clone();
        let dht = self.dht.clone();

        tokio::task::spawn_blocking(move || {
            scan_mdns_blocking(port, &own_pubkey, tx, dht)
        })
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("mDNS task panicked: {:?}", e);
            0
        })
    }

    // ── Subnet scan ───────────────────────────────────────────────────────────

    /// TCP-connect-probe every host on the local /24 subnet.
    ///
    /// We determine our own IP by opening a UDP socket toward a public address
    /// (no packet is actually sent — see `local_ipv4()`), then build a list of
    /// all 253 candidate addresses in the same /24, excluding ourselves.
    ///
    /// Probes run in parallel batches of `SCAN_CONCURRENCY` to keep the total
    /// sweep time acceptable.
    async fn scan_subnet(&self) -> usize {
        let Some(local_ip) = local_ipv4() else {
            tracing::warn!("discovery: could not determine local IP, skipping subnet scan");
            return 0;
        };

        // Build the list of hosts to probe (all /24 neighbours except self).
        let octets = local_ip.octets();
        let candidates: Vec<SocketAddr> = (1u8..=254)
            .filter(|&last| last != octets[3])  // skip our own IP
            .map(|last| {
                let ip = Ipv4Addr::new(octets[0], octets[1], octets[2], last);
                SocketAddr::new(IpAddr::V4(ip), self.port)
            })
            .collect();

        tracing::info!(
            "discovery: probing {}.{}.{}.1-254:{} ({} hosts)",
            octets[0], octets[1], octets[2],
            self.port,
            candidates.len()
        );

        // Probe in parallel batches to stay within OS file descriptor limits.
        let tx = self.tx.clone();
        let dht = self.dht.clone();
        let own_addr = SocketAddr::new(IpAddr::V4(local_ip), self.port);

        let results = probe_batch(candidates, SCAN_CONCURRENCY, own_addr).await;

        let mut count = 0usize;
        for addr in results {
            // Skip peers already in the DHT — they are handled by the existing
            // connection; sending a duplicate discovery event would cause a
            // redundant handshake attempt.
            if dht.peers().await.iter().any(|p| p.addr == addr) {
                continue;
            }
            if tx
                .send(DiscoveredAddr { addr, method: DiscoveryMethod::SubnetScan })
                .await
                .is_err()
            {
                break; // receiver dropped — daemon is shutting down
            }
            count += 1;
        }
        count
    }
}

// ── mDNS blocking implementation ──────────────────────────────────────────────

/// Synchronous mDNS implementation.  Run this on a blocking thread.
///
/// Steps:
///  1. Create the mdns-sd daemon (owns its own I/O threads).
///  2. Disable IPv6 interfaces — agora uses IPv4 exclusively, and IPv6
///     virtual/Docker bridge addresses cause spurious "unreachable" errors.
///  3. Register our own service so other nodes can discover us.
///  4. Browse for the same service type and collect results for `MDNS_WINDOW`
///     seconds.
///  5. Return the count of distinct IP:port addresses found.
fn scan_mdns_blocking(
    port: u16,
    own_pubkey: &str,
    tx: mpsc::Sender<DiscoveredAddr>,
    _dht: Dht,
) -> usize {
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("mDNS daemon failed to start: {}", e);
            return 0;
        }
    };
    // Disable IPv6 mDNS — virtual/Docker bridge interfaces (e.g. br-xxxx)
    // often have link-local or ULA IPv6 addresses with no actual internet
    // routing, which causes a flood of "Network is unreachable" errors every
    // scan cycle.  The app uses IPv4 exclusively, so this is safe.
    if let Err(e) = daemon.disable_interface(IfKind::IPv6) {
        tracing::debug!("mDNS: could not disable IPv6 interfaces: {}", e);
    }

    // ── Advertise our own service ──
    // Use the first 8 characters of our pubkey as the instance name so each
    // node has a unique, stable name on the local network.
    let hostname = gethostname();
    let instance = format!("agora-{}", &own_pubkey[..8]); // first 8 chars of pubkey
    // Embed our full public key in the TXT record so peers can verify identity
    // without having to establish a TCP connection first.
    let properties = [("pubkey", own_pubkey)];

    match ServiceInfo::new(
        SERVICE_TYPE,
        &instance,
        &hostname,
        "",   // let mdns-sd fill in the local address automatically
        port,
        &properties[..],
    ) {
        Ok(info) => {
            if let Err(e) = daemon.register(info) {
                tracing::warn!("mDNS register failed: {}", e);
            }
        }
        Err(e) => tracing::warn!("mDNS ServiceInfo build failed: {}", e),
    }

    // ── Browse for other instances ──
    // The daemon will send us `ServiceEvent::ServiceResolved` for every
    // matching service it finds on the LAN.
    let receiver = match daemon.browse(SERVICE_TYPE) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("mDNS browse failed: {}", e);
            return 0;
        }
    };

    // Keep receiving events until `MDNS_WINDOW` elapses.
    let deadline = std::time::Instant::now() + MDNS_WINDOW;
    let mut found = 0usize;

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break; // time window elapsed
        }

        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                // Extract the peer's pubkey from mDNS TXT record.
                let peer_pubkey = info
                    .get_property_val_str("pubkey")
                    .unwrap_or("")
                    .to_string();

                // Skip peers with no pubkey in their TXT record, and skip our
                // own advertisement (we would try to dial ourselves).
                if peer_pubkey.is_empty() || peer_pubkey == own_pubkey {
                    continue;
                }

                // A service may advertise multiple addresses (IPv4 + IPv6);
                // send each one as a separate discovery candidate.
                for addr in info.get_addresses() {
                    let sock_addr = SocketAddr::new(*addr, info.get_port());
                    tracing::info!("mDNS: found {} @ {}", &peer_pubkey[..8], sock_addr);

                    // blocking_send is safe here because we are already on a
                    // blocking thread (spawned via spawn_blocking).
                    // Fire-and-forget: if the channel is full we just skip.
                    let _ = tx.blocking_send(DiscoveredAddr {
                        addr: sock_addr,
                        method: DiscoveryMethod::Mdns,
                    });
                    found += 1;
                }
            }
            Ok(ServiceEvent::SearchStopped(_)) => break, // daemon signalled stop
            Ok(_) => {}  // other events (Searching, ServiceRemoved, etc.) — ignore
            Err(_) => break, // timeout elapsed or channel closed
        }
    }

    // Graceful shutdown — ignore errors on exit since we may already be torn down.
    let _ = daemon.stop_browse(SERVICE_TYPE);

    found
}

// ── Subnet scan helpers ───────────────────────────────────────────────────────

/// Probe a batch of socket addresses concurrently.
/// Returns those that accepted a TCP connection.
///
/// Uses a sliding window approach: start `concurrency` probes, then for each
/// one that completes (success or failure) immediately launch the next candidate
/// from the iterator.  This keeps the concurrency level stable without
/// spawning all 253 tasks at once.
async fn probe_batch(
    candidates: Vec<SocketAddr>,
    concurrency: usize,
    own_addr: SocketAddr,
) -> Vec<SocketAddr> {
    use tokio::task::JoinSet;

    let mut results = Vec::new();
    let mut set = JoinSet::new();
    let mut iter = candidates.into_iter();

    // Fill the initial concurrency window.
    for addr in iter.by_ref().take(concurrency) {
        set.spawn_blocking(move || probe_one(addr));
    }

    while let Some(res) = set.join_next().await {
        // Drain one result, then add the next candidate to maintain concurrency.
        if let Ok(Some(addr)) = res {
            // Exclude our own IP to avoid the daemon trying to connect to itself.
            if addr.ip() != own_addr.ip() {
                results.push(addr);
            }
        }
        if let Some(next) = iter.next() {
            set.spawn_blocking(move || probe_one(next));
        }
    }

    results
}

/// Try a TCP connect to `addr` with a short timeout.
/// Returns `Some(addr)` if the port is open, `None` if it timed out or refused.
fn probe_one(addr: SocketAddr) -> Option<SocketAddr> {
    match TcpStream::connect_timeout(&addr, SCAN_CONNECT_TIMEOUT) {
        Ok(_) => {
            tracing::debug!("subnet: open port at {}", addr);
            Some(addr)
        }
        Err(_) => None,
    }
}

// ── Network helpers ───────────────────────────────────────────────────────────

/// Detect the machine's primary non-loopback IPv4 address.
///
/// Trick: open a UDP socket and "connect" it to a public IP.  No packet is
/// actually sent — UDP "connect" just sets the default remote address, which
/// causes the OS to select the right routing interface and fills in the socket's
/// local address.  We then read that local address back.
fn local_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
        _ => None,
    }
}

/// Best-effort hostname for mDNS advertisement.
/// Reads `/etc/hostname`; falls back to a hardcoded string if unavailable.
fn gethostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "agora-node".to_string())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_ip_detection() {
        // In most CI environments a non-loopback IP is available.
        // If not, just ensure it doesn't panic.
        let ip = local_ipv4();
        if let Some(ip) = ip {
            assert!(!ip.is_loopback());
        }
    }

    #[tokio::test]
    async fn probe_batch_unreachable() {
        // Probing addresses in TEST-NET-1 (192.0.2.x) should return nothing.
        // This is a reserved block guaranteed to be unreachable.
        let candidates: Vec<SocketAddr> = (1u8..=10)
            .map(|i| format!("192.0.2.{}:7777", i).parse().unwrap())
            .collect();
        let own: SocketAddr = "192.0.2.0:7777".parse().unwrap();
        let results = probe_batch(candidates, 5, own).await;
        assert!(results.is_empty());
    }

    #[test]
    fn service_type_format() {
        // Ensure the service type ends with .local. (required by mdns-sd)
        assert!(SERVICE_TYPE.ends_with(".local."));
    }
}
