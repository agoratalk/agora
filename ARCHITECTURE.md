# Agora Architecture

Agora is a censorship-resistant, decentralized social network. Every participant runs the full stack locally — no central servers, no moderators, no kill switch. Users own their identity via cryptographic keypairs and communicate peer-to-peer over a gossip-based network.

---

## Directory Structure

```
agora/
├── daemon/                    # Rust backend — networking, identity, storage, IPC
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs           # Entry point, CLI args, REPL
│       ├── identity.rs       # Ed25519/X25519 keypair management, disk persistence
│       ├── types.rs          # All wire protocol types (WireMessage, payloads, Peer)
│       ├── network.rs        # TCP listener/dialer, handshakes, Tor/I2P transport
│       ├── messaging.rs      # DM encryption (ECDH + AES-GCM), broadcast signing
│       ├── dht.rs            # In-memory peer table with gossip merge and disk sync
│       ├── discovery.rs      # mDNS, subnet scan, bootstrap node dialing
│       ├── posts.rs          # 24-hour rolling post store with dedup
│       └── ipc.rs            # Local JSON-RPC server for the frontend (port 7779)
│
├── electron/                  # Desktop client — Electron + HTML/CSS/JS
│   ├── main.js               # Main process: spawn daemon, relay IPC, VPN management
│   ├── preload.js            # contextBridge: exposes window.agora to renderer
│   ├── index.html            # UI shell: titlebar, sidebar, main content
│   ├── style.css
│   └── js/
│       ├── events.js         # Central handler for daemon events
│       ├── state.js          # Global in-memory state (peers, posts, DMs, settings)
│       ├── actions.js        # UI actions (send, post, like, follow, block)
│       ├── render.js         # Feed, peer list, DM thread rendering
│       ├── onboarding.js     # Multi-step first-run wizard
│       ├── follow.js         # Follow/block, list management
│       ├── groups.js         # Group chat
│       ├── channels.js       # Topic channels
│       ├── lists.js          # Shared blocklists/followlists
│       ├── score.js          # Feed ranking algorithm
│       ├── helpers.js        # Crypto utilities, image handling, text parsing
│       ├── i18n.js           # Translations (EN/ES/FR/DE/PT/ZH/AR/RU/JA/HI)
│       ├── profile.js        # Profile view/edit
│       └── ui.js             # Generic UI helpers
│
├── web/                       # Lightweight web UI (Docker/browser access)
│   ├── web-server.js         # Node.js HTTP server + WebSocket ↔ IPC proxy
│   └── agora-shim.js         # Browser-compatible window.agora wrapper
│
├── Dockerfile                 # Multi-stage: Rust daemon build → Node runtime
├── docker-compose.yml         # 10-node local test network (alice–judy)
└── docker-compose.single.yml  # Single node
```

---

## Core Concepts

### Identity

Each user has two keypairs derived from the same 32-byte seed:

| Keypair | Algorithm | Purpose |
|---------|-----------|---------|
| Signing | Ed25519 | Permanent identity, message signatures |
| Encryption | X25519 | ECDH key exchange for DM encryption |

The X25519 keypair is derived deterministically from the Ed25519 seed via SHA-256, so only the seed is persisted.

**Fingerprint format:** `A1:B2:C3:D4:E5:F6:07:08` — 8 bytes of `SHA-256(pubkey)` in hex-colon notation. This is what users share to identify themselves.

**Storage:** `~/.config/agora/identities/<account>.json` (Linux/macOS) or `%APPDATA%\agora\identities\` (Windows). Files are chmod 0600 on Unix and written atomically (write to `.tmp`, then rename).

Multiple accounts are supported. `~/.config/agora/active_identity` stores the current account name.

---

## Wire Protocol

All network data is **length-prefixed JSON over TCP**:

```
[4-byte big-endian length] [JSON-serialized WireMessage]
```

`WireMessage` (defined in `types.rs`) is an enum:

```rust
enum WireMessage {
    Hello(HelloPayload),
    DirectMessage(DirectMessagePayload),
    Broadcast(BroadcastPayload),
    Like(LikePayload),
    Comment(CommentPayload),
    CommentLike(CommentLikePayload),
    Ack { message_id: String },
}
```

### HelloPayload — Sent immediately on every connection (both sides)

- `sender_pubkey` + `sender_x25519_pubkey`: Identity
- `signature`: Ed25519 over `(message_id + pubkey + x25519_pubkey + timestamp)`
- `known_peers[]`: Full DHT — this is how gossip propagates
- `recent_posts[]`: Up to 50 posts from last 24h
- `recent_comments[]`: Up to 200 comments from last 24h
- `recent_likes[]`: Up to 500 recent likes
- Timestamp + 30-second replay protection window

Both sides send Hello simultaneously without waiting. After a handshake both peers immediately know each other's profile data and full peer tables.

### DirectMessagePayload — Encrypted DM

Encryption scheme: **X25519 ECDH → HKDF-SHA-256 → AES-256-GCM**

```
shared_secret = sender_x25519_secret × recipient_x25519_public
key           = HKDF(shared_secret, salt="agora-v1", info=message_id)
ciphertext    = AES-256-GCM(key, nonce=random 12 bytes, plaintext)
signature     = Ed25519.Sign(message_id || nonce_b64 || ciphertext_b64)
```

Using `message_id` as the HKDF `info` parameter means a replay of an old ciphertext cannot produce a valid (key, nonce) pair for a different message ID.

### BroadcastPayload — Public signed post

```
signature = Ed25519.Sign(message_id || content || optional_image)
```

Posts older than 24 hours are dropped. Optional fields: `image` (base64 data URL), `embed_url` (YouTube/Twitter/Vimeo/Spotify).

---

## Daemon Modules

### network.rs

One persistent inbound `TcpListener` on port 7777 (configurable). Outbound connections are spawned as short-lived tasks.

**Transport modes:**
- **Raw**: Direct TCP (exposes real IP)
- **Tor**: Outbound via embedded arti client (no external Tor daemon needed; bootstrap takes 10–60s on first use)
- **I2P**: Outbound via local SOCKS5 proxy at `127.0.0.1:4447` (requires local I2P router)

**Max frame size:** 4 MB (prevents memory exhaustion attacks).

**Connection dedup:** `active_peers` HashSet tracks pubkeys with open outbound connections.

### dht.rs

In-memory `HashMap<PubKeyB64, Peer>`. Not true Kademlia — the full peer table is gossiped in every `Hello`.

Peer fields: `pubkey`, `fingerprint`, `addr`, `last_seen`, `discovery` (Mdns/SubnetScan/Gossip/Bootstrap), `username`, `avatar`, `bio`, `x25519_pubkey`.

**Merge rules:**
- Only non-None fields are written (partial updates never clear existing profile data)
- `Mdns` discovery method beats `Gossip` for the same peer (direct observation wins)

**Persistence:** `~/.config/agora/dht.json`, flushed every 30 seconds.

**Background tasks:**
- Evict peers not seen for 5 minutes (runs every 60s)
- Flush to disk (runs every 30s)

### discovery.rs

Runs every 60 seconds:

1. **mDNS** — advertise and query `_agora._tcp.local.`, collect responses for 4s
2. **Subnet scan** — if mDNS finds nothing, TCP-probe every host on local /24 (300ms timeout, 64 concurrent)
3. **Bootstrap nodes** — dial explicit addresses from CLI `--bootstrap` flags

**Privacy mode** (enabled when using Tor/I2P): mDNS advertisement and subnet scanning are disabled. Only bootstrap nodes are dialed. Prevents real IP leakage to LAN neighbors.

### posts.rs

Rolling 24-hour store:

```rust
HashMap<post_id, StoredPost>       // post → { payload, likes, comments }
HashMap<comment_id, StoredComment> // comment → { payload, likes }
HashSet<seen>                      // dedup post IDs
HashSet<seen_comments>             // dedup comment IDs
```

Posts arriving after the configurable cap (default 50) are acknowledged to prevent relay loops but not stored. Eviction runs every 5 minutes. Persisted to `~/.config/agora/posts.json`.

**DM history:** Separate append-only log at `~/.config/agora/dms.jsonl` (one JSON object per line), survives daemon restarts.

### ipc.rs

JSON-RPC server at `127.0.0.1:7779` (localhost only). Protocol: newline-delimited JSON over persistent TCP connections.

**Request:**
```json
{ "id": 1, "method": "send_dm", "params": { "recipient": "...", "content": "..." } }
```

**Response:**
```json
{ "id": 1, "result": { ... }, "error": null }
```

**Unsolicited event (daemon → client):**
```json
{ "event": "peers_updated", "data": [ ... ] }
```

**Available methods:**

| Method | Description |
|--------|-------------|
| `whoami` | Current identity info |
| `peers` | Full DHT snapshot |
| `send_dm` | Send encrypted DM |
| `broadcast` | Publish a post |
| `like_post` | Like a post |
| `comment_post` | Comment on a post |
| `get_comments` | Fetch comments for a post |
| `posts` | All stored posts |
| `set_username` / `set_avatar` / `set_bio` | Update profile |
| `connect` | Manually dial a peer address |
| `start_discovery` | Trigger mDNS/scan/bootstrap (idempotent) |
| `list_identities` | All local accounts |
| `switch_identity` | Hot-swap active account |
| `create_identity` / `delete_identity` | Account management |
| `set_post_limit` | Change post cap |
| `get_local_ip` | Local IP address |

**Event types pushed to all connected clients:**
`peers_updated`, `message`, `like_update`, `like_notification`, `comment_update`, `tor_status`

---

## Electron Desktop Client

Electron splits execution into two isolated contexts:

**Main process (`main.js`)** — full Node.js, OS access:
- Creates `BrowserWindow`
- Spawns daemon child process (looks for binary at `<resources>/bin/agora`, then `../daemon/target/release/agora`, then `PATH`)
- Maintains persistent TCP socket to daemon on port 7779
- Multiplexes all renderer IPC over that single socket (pending requests map by ID)
- Manages VPN processes (`wg-quick` or `openvpn`)

**Renderer process (`index.html` + JS)** — Chromium sandbox:
- Cannot access Node.js or the daemon socket directly
- All daemon communication goes through `window.agora` (exposed by preload)

**Preload bridge (`preload.js`)** — `contextIsolation: true`, `nodeIntegration: false`:
```javascript
contextBridge.exposeInMainWorld('agora', {
  request: (method, params) => ipcRenderer.invoke('daemon-request', method, params),
  onEvent: (callback) => ipcMain.on('daemon-event', callback),
  windowControl: (action) => ipcRenderer.invoke('window-control', action),
})
```

**Full IPC call path:**
```
Renderer JS
  window.agora.request('send_dm', {...})
    → preload: ipcRenderer.invoke('daemon-request', ...)
      → main.js: write JSON line to daemon TCP socket
        → daemon: process, write response line
      → main.js: resolve promise
    → preload: return result
  → Renderer JS: promise resolves
```

---

## Frontend JavaScript

### state.js

All mutable state lives here:
- `myIdentity` — current user's identity object
- `peers[]` — known peers from DHT
- `posts[]` — all posts in store
- `messages{}` — `pubkey → [DM, ...]`
- `followingList`, `blockedList` — Sets of pubkeys (persisted in `localStorage`)
- `blocklists{}`, `followlists{}` — shared community lists

### events.js

Single entry point for all daemon events. Dispatches to the right handler based on `ev.event`. Key logic:
- Content from blocked pubkeys is silently dropped
- `BLOCK_SIGNAL` / `FOLLOW_SIGNAL` magic DM prefixes trigger list imports
- DM unread state tracking

### score.js

Feed ranking:
```
score = recency_boost × likes_weight × (followed_author_boost if following author)
```

### actions.js

All user-initiated operations that talk to the daemon. Import this to wire up UI buttons.

---

## Data Flows

### Posting

```
broadcastPost("Hello world")
  → agora.request('broadcast', { content })
    → daemon: sign → store in posts.rs → relay to all peers
      → event: message { kind: 'broadcast', ... } to all IPC clients
        → events.js: add to posts[], re-render feed
```

### Sending a DM

```
sendDm(recipient_pubkey, "Hello alice")
  → agora.request('send_dm', { recipient, content })
    → daemon: ECDH → HKDF → AES-GCM → sign → TCP to recipient
      → recipient daemon: verify sig → decrypt → emit event
        → recipient events.js: add to messages[], notify
```

### Liking a Post

```
likePost(post_id)
  → agora.request('like_post', { post_id })
    → daemon: sign → store → gossip to all peers
      → if post not mine: send like_notification directly to author
        → events.js: update like count, re-render
```

---

## Storage Layout

All data lives under `~/.config/agora/` (Linux/macOS) or `%APPDATA%\agora\` (Windows):

```
~/.config/agora/
├── identities/
│   ├── default.json         # Identity files (chmod 0600)
│   └── work.json
├── active_identity          # Current account name (plain text)
├── peers.json               # DHT snapshot
├── posts.json               # Post store
└── dms.jsonl                # DM history (append-only, one JSON per line)
```

Frontend state (`followingList`, `blockedList`, unread counts, etc.) is persisted in `localStorage` under keys prefixed with `agora_`.

---

## Privacy

Four connection modes affect peer discovery and transport:

| Mode | Discovery | Transport | Notes |
|------|-----------|-----------|-------|
| Raw | mDNS + subnet scan | Direct TCP | Exposes real IP |
| Tor | Bootstrap only | arti (embedded) | mDNS/scan disabled; 10–60s bootstrap |
| I2P | Bootstrap only | SOCKS5 → I2P | Requires local I2P router |
| WireGuard/OpenVPN | Normal | VPN tunnel | Main process spawns `wg-quick`/`openvpn` |

**Known gaps:** Timing attacks on bootstrap node connects may still leak real IP. Until this is hardened, run behind a trusted VPN or OS-level Tor if anonymity is critical.

---

## Build & Run

### Docker (easiest)

```bash
# Single node — web UI at http://localhost:8080
docker compose -f docker-compose.single.yml up --build

# 10-node test network — alice at :8081, bob at :8082, ... judy at :8090
docker compose up --build
```

### From Source

```bash
# 1. Build and run daemon
cd daemon
cargo build --release
./target/release/agora --port 7777 --ipc-port 7779

# 2. Web bridge (in another terminal)
cd web && npm install && node web-server.js   # http://localhost:8080

# 3. OR desktop client
cd electron && npm install && npm start
```

### Dev Iteration

The daemon supports hot account switching via the `switch` REPL command and `switch_identity` IPC method — no restart needed to test multiple identities.

For network testing, the 10-node Docker compose is the fastest way to observe gossip propagation, post dedup, and DM delivery end-to-end.

---

## Key Design Decisions

- **Gossip = full table in every Hello**: Simple and reliable. Every connection immediately synchronizes the full known network. Scales well for hundreds of peers; would need rethinking at very large scale.
- **HKDF info = message_id**: Ties the derived AES key to a specific message, making replay attacks with captured ciphertexts cryptographically impossible.
- **Both sides send Hello immediately**: No handshake round-trip. Both peers have each other's profile and full DHT within one RTT.
- **Local moderation**: Blocking and following are client-side. There's no way to force a peer to see or hide content — each node enforces its own rules.
- **Post cap + seen set**: Nodes stop storing new posts once the cap is hit but still track `message_id`s in the `seen` set. This prevents relay loops even when storage is full.
