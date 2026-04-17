//! agora — peer-to-peer identity and messaging daemon.
//!
//! ## Architecture
//! The daemon is structured around several independent subsystems that
//! communicate through channels and shared state:
//!
//! ```
//!   [Identity]  — Ed25519/X25519 keypairs + profile (username, avatar, bio)
//!       |
//!   [DHT]       — In-memory peer table, gossiped between nodes
//!       |
//!   [Network]   — TCP listener + outbound dialler + handshake + framing
//!       |
//!   [Messenger] — DM encryption, broadcast signing, like/comment logic
//!       |
//!   [IPC]       — Local TCP JSON-RPC server on 127.0.0.1:7779
//!       |
//!   [Discovery] — mDNS + subnet scan + bootstrap node dialling
//! ```
//!
//! ## Usage
//!   agora                                      # start daemon (auto-loads active identity)
//!   agora --account work --username alice      # start with named account
//!   agora --bootstrap p2p.example.com:7777    # connect to internet peer
//!   agora whoami                               # print identity and exit
//!   agora identities                           # list all saved identities
//!   agora switch <account>                     # switch active identity

// ── Module declarations ───────────────────────────────────────────────────────
mod dht;
mod discovery;
mod identity;
mod ipc;
mod messaging;
mod network;
mod posts;
mod types;

use std::{io::Write, sync::Arc};

use anyhow::Context;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use clap::{Parser, Subcommand};
use tokio::sync::{mpsc, RwLock};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crate::{
    dht::{default_dht_path, Dht},
    discovery::Discoverer,
    identity::Identity,
    ipc::{IpcServer, DEFAULT_IPC_PORT},
    messaging::{InboundKind, Messenger},
    network::{Network, DEFAULT_PORT},
    posts::{default_posts_path, PostStore},
};

// ── CLI definition ────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(name = "agora", about = "Peer-to-peer identity and encrypted messaging", version = "0.2.0")]
struct Cli {
    /// TCP port to listen on for peer connections.
    #[arg(short, long, default_value_t = DEFAULT_PORT)]
    port: u16,
    /// TCP port for the local IPC server (Electron front-end connects here).
    #[arg(long, default_value_t = DEFAULT_IPC_PORT)]
    ipc_port: u16,
    /// Log level (trace/debug/info/warn/error or an env-filter string).
    #[arg(short, long, default_value = "info")]
    log: String,
    /// Account name to use (default: active identity)
    #[arg(short, long)]
    account: Option<String>,
    /// Set or update display username on startup
    #[arg(short, long)]
    username: Option<String>,
    /// Bootstrap peer addresses (host:port).  May be repeated.
    #[arg(short, long = "bootstrap", value_name = "HOST:PORT", action = clap::ArgAction::Append)]
    bootstrap: Vec<String>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Print this node's identity and exit.
    Whoami,
    /// List all saved identities.
    Identities,
    /// Switch the active identity.
    Switch { account: String },
    /// Create a new identity.
    New { account: String, #[arg(short, long)] username: Option<String> },
    /// Delete a saved identity (cannot delete active one).
    Delete { account: String },
}

// ── Main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // Initialise structured logging.  The `EnvFilter` respects the
    // `RUST_LOG` environment variable; the `--log` flag is the fallback.
    tracing_subscriber::registry()
        .with(fmt::layer().with_target(false))
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&cli.log)))
        .init();

    // ── Identity ──────────────────────────────────────────────────────────────
    // Load (or create) the identity first — everything else depends on it.
    let mut identity = if let Some(ref acct) = cli.account {
        Identity::switch_to(acct).context("failed to switch identity")?
    } else {
        Identity::load_or_create().context("failed to initialise identity")?
    };

    // Optionally update the username at startup.
    if let Some(ref uname) = cli.username {
        identity.username = Some(uname.clone());
        identity.save_to_file().context("failed to save username")?;
        tracing::info!("username set to '{}'", uname);
    }

    // ── Subcommands that exit immediately ──────────────────────────────────────
    // These don't start the daemon; they just print info and return.
    match cli.command {
        Some(Command::Whoami) => { identity.print_info(); return Ok(()); }
        Some(Command::Identities) => {
            let list = Identity::list_identities()?;
            println!("\n  Saved identities:");
            println!("  {:<16}  {:<20}  {:<25}  {}", "Account", "Username", "Fingerprint", "Active");
            println!("  {}", "─".repeat(75));
            for id in &list {
                println!("  {:<16}  {:<20}  {:<25}  {}",
                    id.account_name,
                    id.username.as_deref().unwrap_or("(none)"),
                    id.fingerprint,
                    if id.is_active { "✓" } else { "" });
            }
            println!();
            return Ok(());
        }
        Some(Command::Switch { ref account }) => {
            let id = Identity::switch_to(account)?;
            println!("  ✓ Switched to identity '{}'", account);
            id.print_info();
            return Ok(());
        }
        Some(Command::New { ref account, ref username }) => {
            let mut id = Identity::load_or_create_named(account)?;
            if let Some(u) = username { id.username = Some(u.clone()); id.save_to_file()?; }
            println!("  ✓ Created identity '{}'", account);
            id.print_info();
            return Ok(());
        }
        Some(Command::Delete { ref account }) => {
            Identity::delete_named(account)?;
            println!("  ✓ Deleted identity '{}'", account);
            return Ok(());
        }
        None => {}  // No subcommand — start the daemon normally.
    }

    identity.print_info();
    // Wrap the identity in Arc<RwLock<>> so multiple subsystems can share it.
    // The write lock is only held briefly when updating profile fields.
    let identity = Arc::new(RwLock::new(identity));

    // ── DHT ───────────────────────────────────────────────────────────────────
    // Peer table loads from disk immediately so bootstrap addresses are
    // available before the discovery cycle runs.
    let own_pubkey = identity.read().await.pubkey_b64();
    let dht = Dht::new(own_pubkey, default_dht_path()).await;
    // Spawn background eviction and periodic-persist tasks.
    dht.spawn_background_tasks();

    // ── Post store ────────────────────────────────────────────────────────────
    // Rolling 24-hour store for broadcast posts.  Loaded from disk; older
    // posts are discarded at load time and periodically evicted at runtime.
    let post_store = PostStore::new(default_posts_path()).await;

    // ── Network ───────────────────────────────────────────────────────────────
    // Bind the TCP listener.  Inbound connections are handled in spawned tasks.
    let mut network = Network::new(identity.clone(), dht.clone(), cli.port);
    network.set_post_store(post_store.clone());
    network.listen().await.context("failed to bind TCP listener")?;

    // ── Messaging ─────────────────────────────────────────────────────────────
    // Channel for inbound messages: the network layer produces them, the REPL
    // and the IPC broadcaster consume them.
    let (inbound_tx, mut inbound_rx) = mpsc::channel(64);
    let mut messenger = Messenger::new(identity.clone(), dht.clone(), network.clone(), post_store.clone(), inbound_tx);

    // ── IPC ───────────────────────────────────────────────────────────────────
    // Start the JSON-RPC server that the Electron front-end connects to.
    let (ipc_server, broadcaster) = IpcServer::new(cli.ipc_port, identity.clone(), dht.clone(), messenger.clone(), network.clone());
    // Give messenger and network a handle to the broadcaster so they can push
    // events (new DMs, peer updates, etc.) to connected front-ends.
    messenger.set_ipc(broadcaster.clone());
    network.set_ipc(broadcaster.clone());

    // Register the message handler so the network layer routes inbound messages
    // to the messenger's decrypt/verify/dispatch logic.
    messenger.register_with_network().await;
    tokio::spawn(async move { ipc_server.listen().await; });
    tracing::info!("IPC server started on port {}", cli.ipc_port);

    // ── Discovery ─────────────────────────────────────────────────────────────
    // The discoverer produces socket addresses; the network dialler consumes
    // them and performs handshakes.  They are decoupled by an mpsc channel.
    let (discovered_tx, discovered_rx) = mpsc::channel(64);
    let own_pubkey2 = identity.read().await.pubkey_b64();
    let mut discoverer = Discoverer::new(cli.port, own_pubkey2, discovered_tx, dht.clone());
    if !cli.bootstrap.is_empty() { discoverer.add_bootstrap_addrs(&cli.bootstrap); }
    let discoverer = Arc::new(discoverer);
    // The dialler task reads from discovered_rx and calls network.dial() for each.
    network.spawn_dialer(discovered_rx);
    // The periodic discovery task runs mDNS/subnet scan every 60 s.
    discoverer.spawn_periodic();

    println!("\n  Type 'help' for available commands.\n");

    // ── Background: print inbound messages ────────────────────────────────────
    // This task receives decoded inbound messages (DMs, broadcasts, likes) from
    // the messenger and prints them to stdout so the user can see activity while
    // in the REPL.
    tokio::spawn(async move {
        while let Some(msg) = inbound_rx.recv().await {
            let name = msg.sender_username.as_deref().unwrap_or(&msg.sender_fingerprint).to_string();
            match msg.kind {
                InboundKind::Direct { content, .. } => {
                    // Cyan colour for DMs
                    println!("\n  \x1b[36m[DM from {} ({})] \x1b[0m{}", name, &msg.sender_fingerprint, content);
                }
                InboundKind::Broadcast { content, post_id, .. } => {
                    // Yellow colour for public posts
                    println!("\n  \x1b[33m[post {} from {}] \x1b[0m{}", &post_id[..8], name, content);
                }
                InboundKind::Like { post_id, like_count, liker_name, .. } => {
                    // Magenta for like notifications
                    println!("\n  \x1b[35m❤  {} liked your post {} (total: {})\x1b[0m", liker_name, &post_id[..8], like_count);
                }
            }
            // Re-print the prompt so the user knows they can keep typing.
            print!("agora> ");
            let _ = std::io::stdout().flush();
        }
    });

    // ── REPL ──────────────────────────────────────────────────────────────────
    // Interactive command loop — runs until the user types `quit` or EOF.
    run_repl(messenger, dht, network, identity).await;
    Ok(())
}

// ── REPL ──────────────────────────────────────────────────────────────────────

/// Interactive command line loop.
///
/// Reads lines from stdin asynchronously so the Tokio runtime isn't blocked.
/// Commands are parsed as `<keyword> [arguments]` strings.
async fn run_repl(messenger: Messenger, dht: Dht, network: Network, identity: Arc<RwLock<Identity>>) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();

    loop {
        print!("agora> ");
        std::io::stdout().flush().ok();

        let line = match lines.next_line().await {
            Ok(Some(l)) => l.trim().to_string(),
            _ => break,  // EOF (Ctrl-D) or read error — exit the loop
        };
        if line.is_empty() { continue; }

        // Split the first word (command) from the rest (arguments).
        let (cmd, rest) = match line.find(' ') {
            Some(i) => (&line[..i], line[i + 1..].trim()),
            None => (line.as_str(), ""),
        };

        match cmd.to_lowercase().as_str() {
            "help" => print_help(),

            // Print the DHT peer table.
            "peers" => { println!("\n  Known peers:"); dht.print_table().await; println!(); }

            // Print the current identity and peer count.
            "whoami" => {
                let id = identity.read().await;
                id.print_info();
                println!("  Peers known: {}", dht.len().await);
            }

            // List all saved identities.
            "identities" | "accounts" => {
                match Identity::list_identities() {
                    Ok(list) => {
                        println!("\n  Saved identities:");
                        println!("  {:<16}  {:<20}  {:<25}  {}", "Account", "Username", "Fingerprint", "Active");
                        println!("  {}", "─".repeat(75));
                        for id in &list {
                            println!("  {:<16}  {:<20}  {:<25}  {}",
                                id.account_name, id.username.as_deref().unwrap_or("(none)"), id.fingerprint,
                                if id.is_active { "✓" } else { "" });
                        }
                        println!();
                    }
                    Err(e) => println!("  error: {}", e),
                }
            }

            // Create a new identity account.
            "newaccount" | "newid" => {
                let parts: Vec<&str> = rest.splitn(2, ' ').collect();
                if parts.is_empty() || parts[0].is_empty() { println!("  usage: newaccount <name> [username]"); continue; }
                let uname = parts.get(1).map(|s| s.to_string());
                match Identity::load_or_create_named(parts[0]) {
                    Ok(mut id) => {
                        id.username = uname;
                        if let Err(e) = id.save_to_file() { println!("  error: {}", e); continue; }
                        println!("  \x1b[32m✓ created identity '{}'\x1b[0m", parts[0]);
                        id.print_info();
                    }
                    Err(e) => println!("  error: {}", e),
                }
            }

            // Hot-swap the active identity.
            // We can't truly restart the network mid-session, so we update the
            // shared identity fields in-place.  The new signing key takes effect
            // for all subsequent operations (DMs, posts, Hello messages).
            "switch" => {
                if rest.is_empty() { println!("  usage: switch <account>"); continue; }
                match Identity::switch_to(rest) {
                    Ok(new_id) => {
                        let mut id = identity.write().await;
                        id.signing_key = new_id.signing_key;
                        id.verifying_key = new_id.verifying_key;
                        id.x25519_secret = new_id.x25519_secret;
                        id.x25519_public = new_id.x25519_public;
                        id.username = new_id.username.clone();
                        id.account_name = new_id.account_name.clone();
                        drop(id);
                        println!("  \x1b[32m✓ switched to identity '{}'\x1b[0m", rest);
                        identity.read().await.print_info();
                    }
                    Err(e) => println!("  error: {}", e),
                }
            }

            // Delete a saved identity (cannot delete the active one).
            "deleteaccount" => {
                if rest.is_empty() { println!("  usage: deleteaccount <account>"); continue; }
                match Identity::delete_named(rest) {
                    Ok(()) => println!("  \x1b[32m✓ deleted identity '{}'\x1b[0m", rest),
                    Err(e) => println!("  error: {}", e),
                }
            }

            // Update the display username for the current identity.
            "setname" | "username" => {
                if rest.is_empty() { println!("  usage: setname <name>"); continue; }
                let mut id = identity.write().await;
                id.username = Some(rest.to_string());
                match id.save_to_file() {
                    Ok(()) => println!("  \x1b[32m✓ username set to '{}'\x1b[0m", rest),
                    Err(e) => println!("  error: {}", e),
                }
            }

            // Send an encrypted direct message.
            // `parts[0]` is the recipient (pubkey or fingerprint prefix).
            "msg" | "dm" => {
                let parts: Vec<&str> = rest.splitn(2, ' ').collect();
                if parts.len() < 2 || parts[1].is_empty() { println!("  usage: msg <fingerprint> <text>"); continue; }
                match messenger.send_direct(parts[0], parts[1], None).await {
                    Ok(()) => println!("  \x1b[32m✓ message sent\x1b[0m"),
                    Err(e) => println!("  error: {}", e),
                }
            }

            // Broadcast a signed public post.
            "broadcast" | "bc" | "post" => {
                if rest.is_empty() { println!("  usage: post <text>"); continue; }
                match messenger.broadcast(rest, None, None).await {
                    Ok(()) => println!("  \x1b[32m✓ post sent (propagated for 24h)\x1b[0m"),
                    Err(e) => println!("  error: {}", e),
                }
            }

            // Like a post by ID prefix.
            "like" => {
                if rest.is_empty() { println!("  usage: like <post_id_prefix>"); continue; }
                match messenger.like_post(rest).await {
                    Ok(count) => println!("  \x1b[32m✓ liked! Total likes: {}\x1b[0m", count),
                    Err(e) => println!("  error: {}", e),
                }
            }

            // Show the 20 most recent posts in the feed.
            "posts" | "feed" => {
                let mut posts = messenger.post_store().all_posts().await;
                posts.sort_by(|a, b| b.payload.timestamp.cmp(&a.payload.timestamp));
                if posts.is_empty() { println!("  (no posts yet)"); continue; }
                println!();
                let own_pubkey = identity.read().await.pubkey_b64();
                for p in posts.iter().take(20) {
                    let fp = B64.decode(&p.payload.sender_pubkey)
                        .map(|b| crate::identity::pubkey_fingerprint(&b)).unwrap_or_default();
                    let mine = if p.payload.sender_pubkey == own_pubkey { " (yours)" } else { "" };
                    println!("  \x1b[33m[{}]{}\x1b[0m ❤ {}  {}", &p.payload.message_id[..8], mine, p.like_count(), p.payload.content);
                    println!("  \x1b[2m  {} · {}\x1b[0m", fp, p.payload.timestamp.format("%Y-%m-%d %H:%M UTC"));
                    println!();
                }
            }

            // Manually dial a peer.  The dial runs in a background task
            // so the REPL stays responsive.
            "connect" | "dial" => {
                if rest.is_empty() { println!("  usage: connect <host:port>"); continue; }
                use std::net::ToSocketAddrs;
                match rest.to_socket_addrs() {
                    Ok(mut iter) => if let Some(addr) = iter.next() {
                        let net2 = network.clone();
                        tokio::spawn(async move {
                            match net2.dial(addr).await {
                                Ok(()) => println!("  \x1b[32m✓ connected\x1b[0m"),
                                Err(e) => println!("  connect failed: {}", e),
                            }
                        });
                    },
                    Err(e) => println!("  could not resolve: {}", e),
                }
            }

            "quit" | "exit" | "q" => { println!("  Goodbye."); break; }
            other => println!("  Unknown command '{}'. Type 'help'.", other),
        }
    }
}

/// Print the REPL help text.
fn print_help() {
    println!(r#"
  Commands:
    peers                          list known peers
    whoami                         show current identity
    identities                     list all saved identities
    newaccount <name> [user]       create a new identity account
    switch <account>               switch active identity (hot-swap)
    deleteaccount <account>        delete a saved identity
    setname <name>                 set your display username
    post <text>                    send a public post (propagated 24h)
    posts / feed                   show recent public posts
    like <post_id>                 like a post (notifies the author)
    msg <fingerprint> <text>       send an encrypted direct message
    connect <host:port>            dial a peer manually
    help                           show this help
    quit / exit                    shut down
"#);
}
