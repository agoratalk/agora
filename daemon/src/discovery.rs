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
    sync::Arc,
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
const SERVICE_TYPE: &str = "_agora._tcp.local.";

/// How long we listen for mDNS responses before declaring "no peers found".
const MDNS_WINDOW: Duration = Duration::from_secs(4);

/// Timeout for each TCP connect probe in the subnet scan.
const SCAN_CONNECT_TIMEOUT: Duration = Duration::from_millis(300);

/// How many hosts to probe concurrently during subnet scan.
const SCAN_CONCURRENCY: usize = 64;

/// How often the discovery cycle repeats while the daemon is running.
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
    port: u16,
    own_pubkey: String,
    /// Sends newly found addresses to the network layer for handshaking.
    tx: mpsc::Sender<DiscoveredAddr>,
    dht: Dht,
    /// Bootstrap node addresses supplied via CLI or config.
    bootstrap_addrs: Vec<SocketAddr>,
}

impl Discoverer {
    pub fn new(
        port: u16,
        own_pubkey: String,
        tx: mpsc::Sender<DiscoveredAddr>,
        dht: Dht,
    ) -> Self {
        Self { port, own_pubkey, tx, dht, bootstrap_addrs: Vec::new() }
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

        tracing::info!("discovery: mDNS found nothing — falling back to subnet scan");
        let subnet_found = self.scan_subnet().await;
        tracing::info!("discovery: subnet scan found {} candidate(s)", subnet_found);
        subnet_found
    }

    /// Spawn a background task that re-runs discovery every `SCAN_INTERVAL`.
    /// Spawn a background task that re-runs discovery every `SCAN_INTERVAL`.
    /// Bootstrap nodes are re-dialled each cycle so we reconnect if they restart.
    pub fn spawn_periodic(self: Arc<Self>) {
        tokio::spawn(async move {
            // Bootstrap dial runs first so internet peers are ready before
            // local mDNS/subnet scan completes.
            self.dial_bootstrap_nodes().await;
            self.run_once().await;

            let mut ticker = time::interval(SCAN_INTERVAL);
            ticker.tick().await; // consume the first immediate tick
            loop {
                ticker.tick().await;
                tracing::info!("discovery: periodic re-scan");
                self.dial_bootstrap_nodes().await;
                self.run_once().await;
            }
        });
    }

    // ── mDNS ──────────────────────────────────────────────────────────────────

    async fn scan_mdns(&self) -> usize {
        let port = self.port;
        let own_pubkey = self.own_pubkey.clone();
        let tx = self.tx.clone();
        let dht = self.dht.clone();

        // mDNS is synchronous (mdns-sd uses its own threads), so we run it
        // in a blocking task to avoid stalling the async executor.
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

    async fn scan_subnet(&self) -> usize {
        let Some(local_ip) = local_ipv4() else {
            tracing::warn!("discovery: could not determine local IP, skipping subnet scan");
            return 0;
        };

        // Build the list of hosts to probe (all /24 neighbours except self).
        let octets = local_ip.octets();
        let candidates: Vec<SocketAddr> = (1u8..=254)
            .filter(|&last| last != octets[3])
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

        // Probe in parallel batches.
        let tx = self.tx.clone();
        let dht = self.dht.clone();
        let own_addr = SocketAddr::new(IpAddr::V4(local_ip), self.port);

        let results = probe_batch(candidates, SCAN_CONCURRENCY, own_addr).await;

        let mut count = 0usize;
        for addr in results {
            // Skip peers already in the DHT (still refresh them via touch later).
            if dht.peers().await.iter().any(|p| p.addr == addr) {
                continue;
            }
            if tx
                .send(DiscoveredAddr { addr, method: DiscoveryMethod::SubnetScan })
                .await
                .is_err()
            {
                break; // receiver dropped — shutting down
            }
            count += 1;
        }
        count
    }
}

// ── mDNS blocking implementation ──────────────────────────────────────────────

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
    let hostname = gethostname();
    let instance = format!("agora-{}", &own_pubkey[..8]); // first 8 chars of pubkey
    let properties = [("pubkey", own_pubkey)];

    match ServiceInfo::new(
        SERVICE_TYPE,
        &instance,
        &hostname,
        "",   // let mdns-sd fill in the local address
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
    let receiver = match daemon.browse(SERVICE_TYPE) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("mDNS browse failed: {}", e);
            return 0;
        }
    };

    let deadline = std::time::Instant::now() + MDNS_WINDOW;
    let mut found = 0usize;

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }

        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                // Extract the peer's pubkey from mDNS TXT record.
                let peer_pubkey = info
                    .get_property_val_str("pubkey")
                    .unwrap_or("")
                    .to_string();

                if peer_pubkey.is_empty() || peer_pubkey == own_pubkey {
                    continue;
                }

                for addr in info.get_addresses() {
                    let sock_addr = SocketAddr::new(*addr, info.get_port());
                    tracing::info!("mDNS: found {} @ {}", &peer_pubkey[..8], sock_addr);

                    // Fire-and-forget: if the channel is full we just skip.
                    let _ = tx.blocking_send(DiscoveredAddr {
                        addr: sock_addr,
                        method: DiscoveryMethod::Mdns,
                    });
                    found += 1;
                }
            }
            Ok(ServiceEvent::SearchStopped(_)) => break,
            Ok(_) => {}
            Err(_) => break, // timeout or channel closed
        }
    }

    // Graceful shutdown — ignore errors on exit.
    let _ = daemon.stop_browse(SERVICE_TYPE);

    found
}

// ── Subnet scan helpers ───────────────────────────────────────────────────────

/// Probe a batch of socket addresses concurrently.
/// Returns those that accepted a TCP connection.
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
        // Drain one result, then add the next candidate.
        if let Ok(Some(addr)) = res {
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

/// Try a TCP connect to `addr`. Returns `Some(addr)` if it succeeds.
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

/// Detect the machine's primary non-loopback IPv4 address by opening a UDP
/// socket toward a public IP (no packet is actually sent).
fn local_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
        _ => None,
    }
}

/// Best-effort hostname for mDNS advertisement.
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
