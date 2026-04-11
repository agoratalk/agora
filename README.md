# Agora

**A decentralized platform for free speech.**

Agora is a peer-to-peer social network with no central servers, no moderators, no
corporate gatekeepers, and no kill switch. Identities are cryptographic, messages
and posts are carried across a DHT-based overlay, and every participant runs the
full stack themselves. Nobody can ban you, shadow-ban you, throttle your reach,
or take the network down — because there is no "they" in the middle.

Agora exists because the places where people used to argue, joke, organize, and
think out loud have been quietly fenced in. This is an attempt to build somewhere
that can't be fenced.

---

## ⚠️ Work in progress — read this before you run it

Agora is **early, experimental, and actively buggy**. Things will crash. State
will occasionally corrupt. Features half-exist. APIs will change without warning.
Do not rely on it for anything that matters yet.

### 🔴 It will leak your IP address

The current networking layer connects your machine directly to other peers. That
means **other peers on the network can see your real IP address**. There is no
onion routing, no mixnet, and no traffic obfuscation in this build.

**If you care at all about your privacy or your safety, run Agora behind a VPN.**
A trustworthy VPN, Tor routing at the OS level, or a dedicated VPS you treat as
disposable are all reasonable options. Running it raw from your home connection
is not.

This will be addressed in future versions. Until then: assume every peer you talk
to knows where you are.

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

```bash
git clone https://github.com/agoratalk/agora.git agora
cd agora
docker compose up --build
```

The daemon will start, generate an identity on first run, and begin looking for
peers. The web UI will be available at `http://localhost:8080` (check
`docker-compose.yml` for the exact port).

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

The daemon stores its identity and data under your OS's standard application
data directory. Back that folder up if you want to keep your identity.

### First steps once it's running

1. Open the web UI or the Electron client.
2. Confirm the daemon generated an identity and note your handle.
3. Wait a moment for peer discovery — this can take a few seconds to a few
   minutes depending on how many bootstrap peers are reachable.
4. Try posting, try messaging, try following someone. Try to break it. That's
   how it gets better.

---

## Contributing

**Help is very welcome and very needed.** Agora is a small project with large
ambitions, and essentially every area has open problems: networking, privacy,
storage, moderation tooling at the client level, UX, docs, packaging, tests,
and of course the long road toward hiding your IP properly.

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

## Planned features

A rough wishlist of what Agora should grow into. No promises on order or
timing — see the note on pace below.

- **Windows desktop app** — a native `.exe` installer so Windows users can run Agora without a terminal or manual setup.                                                             
- **Linux packages** — packaged releases for major distros (`.deb`, `.rpm`, and others) so Agora can be installed through standard system package managers.
- **Tor transport** — route daemon traffic through Tor so peers no longer
  see your real IP. This is the single biggest privacy fix on the list.
- **Fixing all the bugs.** The ever-present one.
- **Following other users** and a proper follow graph.
- **A local feed algorithm** — ranking and filtering that runs entirely on
  your own machine, with no remote black box deciding what you see.
- **Channels** for different topics, so conversations can be organized
  without central moderators.
- **Group chat.**
- **Android app** — a native mobile client distributed as an APK, so people can use Agora without needing a desktop.
- **Sending pictures** in messages and posts.
- **Profile pictures** and richer profile metadata.
- **Embedding content** from other platforms (videos, links, etc.) in posts.
- **User blocking and shareable blocklists** — client-side tools to mute or block individual users, plus the ability to publish and subscribe to blocklists curated by others. Moderation that lives with the user, not with a central authority: nobody is removed from the network, but everyone gets to decide who they see.
- **Monero wallet integration** for private, peer-to-peer tipping and
  payments between users.

## A note on pace

Agora is a side project I work on in my free time, around a day job and the
rest of life. That means progress will be slow and bursty — expect quiet
weeks, the occasional flurry, and bugs that sit in the tracker longer than
they should. This is part of why contributions matter so much: every patch,
issue, or bit of testing moves things forward faster than I can alone.

I will add social media accounts to promote the project and a Monero wallet for donations at a later date.
