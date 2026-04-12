# ── Stage 1: build the Rust daemon ─────────────────────────────────────────────
FROM rust:1.90-slim AS daemon-build
WORKDIR /build
# No libssl-dev needed: TLS uses rustls (pure Rust) and SQLite is bundled.
# Only need build tools for compiling C extensions (ring, sqlite bundled).
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*

# Copy manifest + (optionally) lockfile. Cargo.* matches Cargo.toml and Cargo.lock if present.
COPY daemon/Cargo.* ./
COPY daemon/src ./src

RUN if [ -f Cargo.lock ]; then \
      echo "[build] Cargo.lock found — building with --locked"; \
      cargo build --release --locked; \
    else \
      echo "[build] no Cargo.lock — resolving fresh (not reproducible)"; \
      cargo build --release; \
    fi

# ── Stage 2: runtime with Node for the web bridge ──────────────────────────────
FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=daemon-build /build/target/release/agora /usr/local/bin/agora
COPY web/ /app/web/
COPY electron/index.html /app/electron/index.html
WORKDIR /app/web
RUN npm install ws --omit=dev

EXPOSE 7777 8080

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
