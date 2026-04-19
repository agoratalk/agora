# Agora

**Speak freely. Moderate locally. Own your identity.**

Agora is not just a social network, it's an open-source distributed systems project building censorship-resistant social infrastructure, no central servers, no moderators, no corporate gatekeepers, and no kill switch. Identities are cryptographic, messages and posts are carried across a DHT-based overlay, and every participant runs the full stack themselves. Nobody can ban you, shadow-ban you, throttle your reach, or take the network down — because there is no "they" in the middle.

Agora exists because the places where people used to argue, joke, organize, and think out loud have been quietly fenced in. This is an attempt to build somewhere that can't be fenced.

![Agora screenshot](agora_example_picture.png)

---

## Easy installers coming soon

One-click installers for **Windows** and **Linux** are in the works, so you'll
be able to get up and running without a terminal or a Rust toolchain. For now,
see the Docker and build-from-source instructions below.

---

## Alpha release — read this before you run it

Agora is **usable for testing, but expect rough edges**. Some things will crash.
APIs may change. Features are still being hardened. Do not rely on it for
anything critical yet.

### 🟡 IP hiding is implemented but needs more work

Ways to hide your IP address are implemented — you can select Tor, I2P, WireGuard,
OpenVPN, or other transports during onboarding or in Settings. In Tor mode the
daemon runs an embedded Tor client (via [arti](https://gitlab.torproject.org/tpo/core/arti))
with no external `tor` binary required, and LAN discovery (mDNS + subnet scan)
is suppressed so your local IP is not broadcast to neighbours.

**However, this is still being hardened.** Due to limitations in the peer discovery
and DHT gossip layer, your real IP address may still be exposed to other peers
in some situations — for example when connecting through a bootstrap node, or
if a timing edge-case causes a raw connection before the transport is fully up.
**Do not rely on these features for strong anonymity yet.**

Contributions to harden IP privacy are very welcome — see the Contributing
section below. Until this is solid, running Agora behind a trusted VPN or Tor
at the OS level remains the safest option.

---

## How it works (short version)

- **`daemon/`** — Rust node that handles identity, the DHT, peer discovery,
  messaging, and posts. This is the heart of Agora.
- **`electron/`** — Desktop client (Electron) that talks to a local daemon.
- **`web/`** — Lightweight web UI server for browser-based access to a local
  daemon.
- **`Dockerfile` / `docker-compose.yml`** — One-command way to run a node
  without installing a Rust toolchain.

Your identity is a keypair generated on first run. Your handle is derived from
your public key. Don't lose your key — losing it means losing the identity.

---

## Running it

### Option 1: Docker (easiest)

There are two Compose files depending on your use case:

**Single peer** — for normal use, running one node on your machine:

```bash
git clone https://github.com/agoratalk/agora.git agora
cd agora
docker compose -f docker-compose.single.yml up --build
```

The web UI will be available at `http://localhost:8080`.

**Ten peers** — for local testing and development, spins up a small simulated
network on your machine with peers alice through judy:

```bash
git clone https://github.com/agoratalk/agora.git agora
cd agora
docker compose up --build
```

Web UIs for each peer are available at `http://localhost:8081` through
`http://localhost:8090`.

**Reminder:** route the container through your VPN, or run it on a VPS you don't
mind being linked to.

### Option 2: Build from source

Requirements: a recent Rust toolchain (`rustup` recommended) and Node.js 18+ for
the clients.

```bash
# Daemon
cd daemon
cargo build --release
./target/release/agora

# Web client (in another terminal)
cd web
npm init -y
npm install ws
node web-server.js

# Desktop client (in another terminal)
cd electron
npm install
npm start
```

The daemon stores its identity and data under:

- **Linux/macOS**: `~/.config/agora/` (or `$XDG_CONFIG_HOME/agora/` if that variable is set)
- **Windows**: `%APPDATA%\agora\`

Individual identities are stored as JSON files inside the `identities/`
subdirectory (e.g. `~/.config/agora/identities/default.json`). Back up that
directory if you want to keep your identity.

### First steps once it's running

1. Open the web UI or the Electron client.
2. Confirm the daemon generated an identity and note your handle.
3. Wait a moment for peer discovery — this can take a few seconds to a few
   minutes depending on how many bootstrap peers are reachable.
4. Try posting, try messaging, try following someone.

---

## Contributing

**Help is very welcome and very needed.** Agora is a small project with large
ambitions, and essentially every area has open problems: networking, privacy,
storage, moderation tooling at the client level, UX, docs, packaging, tests,
and of course the long road toward hiding your IP properly.

Please check ARCHITECTURE.md to learn more about how the software itself works. Contributions to ARCHITECTURE.md itself is of course also very welcome.

Good ways to contribute:

- **File issues.** Crashes, weird behavior, confusing UI, documentation gaps —
  all useful. Include logs and steps to reproduce where you can.
- **Send patches.** Small PRs are easier to review than large ones. If you're
  planning something substantial, open an issue first so we can talk through it.
- **Privacy and networking work is the highest priority.** If you have
  experience with Tor, I2P, mixnets, NAT traversal, or onion routing, your help
  would be enormous.
- **Try to break it.** Adversarial testing is contribution.
- **Docs and translations.** Making Agora approachable to non-technical users
  matters.

There's no CLA. Be decent to other contributors. That's the whole code of
conduct.

## Why contribute?

Agora is an unusually broad engineering challenge. Contributors can work on:

- Rust networking + P2P systems
- Cryptographic identity
- Desktop UI / Electron
- Web frontend
- Spam resistance
- Local moderation systems
- Packaging / installers
- Internationalization
- Protocol design

If you like hard problems and open systems, you'll probably enjoy this project. If you dont know where to start look at the feature lists below, let something grab your attention and work on it, basically everything needs more work.

---

## License

Agora is released under the **WTFPL v2** (Do What The Fuck You Want To Public
License, version 2). See the `LICENSE` file. In short: do whatever you want
with this code. Fork it, ship it, sell it, rewrite it, burn it down. That's
the point.

---

## A note on the name

Agora — the open square where citizens gathered to speak, argue, trade, and
decide things in the open. That's the idea. Come build it.

---

## Current features

Those features are currently working but they can and will be improved.
| Feature | Notes |
|---|---|
| **Following and blocking, and shareable lists** | Follow users and organise them into named follow lists you can publish for others to subscribe to. Block individual users and share blocklists curated by you or imported from peers you trust. Moderation that lives with the user, not a central authority. |
| **Channels for different topics** | Topic-scoped channels inside the public feed, so conversations can be organised without central moderators. Posts in a channel only appear in that channel; the public feed stays uncluttered. |
| **Multilanguage support** | Full UI localisation covering a range of languages so Agora is accessible to a wider global audience without needing to read English. If a translation feels off or you are fluent in a language not yet covered, contributions are very welcome. |
| **Group chats** | Encrypted group messaging built on top of the existing DM layer, with admin roles, invite/kick controls, and forward secrecy inherited from the per-message key exchange. |
| **Profile pictures and richer profile metadata** | Upload an avatar and write a short bio that other peers can see when they open your profile. |
| **A local feed algorithm** | Ranking and filtering that runs entirely on your own machine, with no remote black box deciding what you see. |
| **Post cap** | Set a maximum number of posts your daemon will store and process. Once the cap is reached, new incoming posts are acknowledged (so they aren't re-relayed through you) but not stored, keeping memory and CPU usage predictable. Configurable at any time from Settings. |
| **User-friendly onboarding** | A guided first-run flow that walks new users through generating an identity, choosing a display name, and connecting to the network — no command-line knowledge required. |

---

## Features currently being worked on

Everything in this list is actively being worked on right now.

| Feature | Notes |
|---|---|
| **Secure connections that hide your IP** | Route daemon traffic through Tor, I2P, WireGuard, OpenVPN, Nym, or QUIC so peers no longer see your real IP address. All options are selectable per-session from Settings. Note: this is extremely unstable as of writing. |
| **Fixing all the bugs** | The ever-present one. |
| **Embedding content from other platforms** | Paste a link into a post and have it rendered as a preview (video player, image, or link card) inline in the feed. |
| **Proof of work per post and DM** | Each post and direct message will require a small proof-of-work stamp before it is accepted by the network, making automated spam campaigns computationally expensive while remaining invisible to normal users. |
| **Mnemonic backup for identity recovery** | Your identity keypair will be representable as a human-readable mnemonic phrase you can write down and use to restore your account on any device, so losing a device no longer means losing your identity permanently. |


---

## Planned features

These are on the roadmap but not currently being worked on.


| Feature | Notes |
|---|---|
| **Logo design** | Agora doesn't have a logo yet. A proper identity is in progress. |
| **Windows desktop app** | A native `.exe` installer so Windows users can run Agora without a terminal or manual setup. A non-Electron app for performance would be good too but I would need contributors with desktop dev experience to build something good. |
| **Linux packages** | Packaged releases for major distros (`.deb`, `.rpm`, and others) so Agora can be installed through standard system package managers. |
| **Android app** | A native mobile client distributed as an APK so people can use Agora without needing a desktop. |
| **Monero wallet integration for private payments** | Peer-to-peer tipping and payments between users using Monero, with no payment processor in the middle. |
| **All the good features you are used to** | This is an extremely long-term goal, and something we probably won't see for years, but Agora will continue to develop and add more features like P2P voice calls, screen sharing, file sharing etc. |
| **Developer friendliness** | Agora welcomes developers to create their own custom frontend, custom daemons with new features etc. |

## A note on pace

Agora is a side project I work on in my free time, around a day job and the
rest of life. That means progress will be slow and bursty — expect quiet
weeks, the occasional flurry, and bugs that sit in the tracker longer than
they should. This is part of why contributions matter so much: every patch,
issue, or bit of testing moves things forward faster than I can alone.

## Legal Notice for Agora

Users are responsible for complying with local laws.
Agora is provided as-is without warranty.

## Other

Backup (may not be up to date) : https://gitlab.com/ryan_agora-group

X / Twitter : https://x.com/ryan_agora

More accounts and a Monero donation wallet coming soon.
