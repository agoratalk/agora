//! Identity management: multi-account Ed25519 + X25519 keypairs, persistence, username.
//!
//! Each identity has:
//!  - An **Ed25519** signing keypair — used to sign messages so peers can verify
//!    authenticity.  The public half is the "public key" visible to others.
//!  - An **X25519** Diffie-Hellman keypair — used for end-to-end encrypted DMs.
//!    Derived deterministically from the Ed25519 seed so we only ever store one
//!    secret per identity file.
//!
//! Identities live in `~/.config/agora/identities/<name>.json`
//! The active identity is tracked in `~/.config/agora/active_identity`

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as X25519Public, StaticSecret as X25519Secret};

use crate::types::{Fingerprint, P2pError, PubKeyB64, Result};

/// On-disk representation of a single identity file.
/// Only the seed bytes (not the full key) are stored — the keys are derived
/// on load.  The X25519 secret is stored explicitly because it is derived
/// from the Ed25519 seed via a domain-separated hash (see `derive_x25519_secret`).
#[derive(Serialize, Deserialize)]
struct IdentityFile {
    /// Base64-encoded 32-byte Ed25519 seed (the private key material).
    ed25519_seed: String,
    /// Base64-encoded 32-byte X25519 static secret (derived from ed25519_seed).
    x25519_secret: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub account_name: String,
    /// Base64-encoded avatar image data URL
    #[serde(default)]
    pub avatar: Option<String>,
    /// Short bio/description (max 500 chars, enforced by client).
    #[serde(default)]
    pub bio: Option<String>,
}

/// In-memory identity — all crypto keys loaded and ready for use.
pub struct Identity {
    /// Full signing key (includes the seed; keep this secret).
    pub signing_key: SigningKey,
    /// The public half of the Ed25519 keypair.  This is the identity
    /// as seen by other peers — base64-encoded it becomes the `pubkey` field.
    pub verifying_key: VerifyingKey,
    /// X25519 static secret for ECDH key exchange (used in DM encryption).
    pub x25519_secret: X25519Secret,
    /// X25519 public key — shared in Hello messages so peers can encrypt DMs to us.
    pub x25519_public: X25519Public,
    pub username: Option<String>,
    /// Internal account name (filesystem label, not shown to peers).
    pub account_name: String,
    /// Base64-encoded avatar image data URL (e.g. "data:image/jpeg;base64,...")
    pub avatar: Option<String>,
    /// Short bio/description (max 500 chars).
    pub bio: Option<String>,
    /// Where this identity is saved on disk.
    path: PathBuf,
}

/// Summary of an identity for listing/switching purposes (no secret material).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentitySummary {
    pub account_name: String,
    pub username: Option<String>,
    /// Human-readable fingerprint derived from the public key.
    pub fingerprint: String,
    /// Base64-encoded Ed25519 public key.
    pub pubkey: String,
    /// Whether this is the currently-active identity.
    pub is_active: bool,
    pub avatar: Option<String>,
    pub bio: Option<String>,
}

impl Identity {
    /// Load the active identity, or create a new "default" one if none exists.
    /// This is the main entry point used at daemon startup.
    pub fn load_or_create() -> Result<Self> {
        let active = active_identity_name()?;
        let name = active.as_deref().unwrap_or("default");
        let path = identity_path(name)?;
        if path.exists() {
            tracing::info!("loading identity '{}' from {}", name, path.display());
            Self::load_from_file(&path)
        } else {
            tracing::info!("no identity '{}' found — generating a new one", name);
            let id = Self::generate(path.clone(), name.to_string());
            id.save_to_file()?;
            // Mark this as the active identity so future startups load it.
            set_active_identity(name)?;
            tracing::info!("identity saved to {}", path.display());
            Ok(id)
        }
    }

    /// Load or create an identity by explicit account name (without changing
    /// the active pointer).  Used for `newaccount` and `create_identity`.
    pub fn load_or_create_named(name: &str) -> Result<Self> {
        let path = identity_path(name)?;
        if path.exists() {
            tracing::info!("loading identity '{}'", name);
            Self::load_from_file(&path)
        } else {
            tracing::info!("creating new identity '{}'", name);
            let id = Self::generate(path.clone(), name.to_string());
            id.save_to_file()?;
            Ok(id)
        }
    }

    /// Switch the active identity to `name` and return the loaded identity.
    pub fn switch_to(name: &str) -> Result<Self> {
        set_active_identity(name)?;
        Self::load_or_create_named(name)
    }

    /// List all identities found in the identities directory, sorted by name.
    pub fn list_identities() -> Result<Vec<IdentitySummary>> {
        let dir = identities_dir()?;
        if !dir.exists() { return Ok(vec![]); }
        let active = active_identity_name()?.unwrap_or_default();
        let mut result = vec![];
        for entry in std::fs::read_dir(&dir).map_err(|e| P2pError::Identity(e.to_string()))? {
            let entry = entry.map_err(|e| P2pError::Identity(e.to_string()))?;
            let path = entry.path();
            // Only process JSON files, skip other files (e.g. .tmp left by a crash).
            if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            if let Ok(id) = Self::load_from_file(&path) {
                result.push(IdentitySummary {
                    account_name: id.account_name.clone(),
                    username: id.username.clone(),
                    fingerprint: id.fingerprint(),
                    pubkey: id.pubkey_b64(),
                    is_active: id.account_name == active,
                    avatar: id.avatar.clone(),
                    bio: id.bio.clone(),
                });
            }
        }
        result.sort_by(|a, b| a.account_name.cmp(&b.account_name));
        Ok(result)
    }

    /// Delete a saved identity by account name.
    /// Refuses to delete the currently-active identity to prevent the daemon
    /// from running without any identity.
    pub fn delete_named(name: &str) -> Result<()> {
        let active = active_identity_name()?.unwrap_or_default();
        if active == name {
            return Err(P2pError::Identity("cannot delete the active identity".into()));
        }
        let path = identity_path(name)?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| P2pError::Identity(e.to_string()))?;
        }
        Ok(())
    }

    /// Generate a brand-new identity from OS random entropy.
    /// Does NOT save to disk — call `save_to_file()` afterwards.
    pub fn generate(path: PathBuf, account_name: String) -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        // Derive the X25519 secret from the Ed25519 seed so we have only
        // one secret to back up.  See `derive_x25519_secret` for details.
        let x25519_secret = derive_x25519_secret(signing_key.as_bytes());
        let x25519_public = X25519Public::from(&x25519_secret);
        Self { signing_key, verifying_key, x25519_secret, x25519_public, username: None, avatar: None, bio: None, account_name, path }
    }

    /// Load an identity from a JSON file on disk.
    /// Returns an error if the file is missing, malformed, or contains
    /// improperly-encoded key material.
    pub fn load_from_file(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| P2pError::Identity(format!("cannot read identity file: {e}")))?;
        let file: IdentityFile = serde_json::from_str(&raw)
            .map_err(|e| P2pError::Identity(format!("malformed identity file: {e}")))?;

        // Decode the Ed25519 seed and reconstruct the full signing key.
        let seed_bytes = B64.decode(&file.ed25519_seed)
            .map_err(|e| P2pError::Identity(format!("bad base64 in ed25519_seed: {e}")))?;
        let seed: [u8; 32] = seed_bytes.try_into()
            .map_err(|_| P2pError::Identity("ed25519_seed must be 32 bytes".into()))?;
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();

        // Decode the X25519 static secret.
        let x_bytes = B64.decode(&file.x25519_secret)
            .map_err(|e| P2pError::Identity(format!("bad base64 in x25519_secret: {e}")))?;
        let x_arr: [u8; 32] = x_bytes.try_into()
            .map_err(|_| P2pError::Identity("x25519_secret must be 32 bytes".into()))?;
        let x25519_secret = X25519Secret::from(x_arr);
        let x25519_public = X25519Public::from(&x25519_secret);

        // Use the file stem as the account name for identities created before
        // the account_name field was added (backwards compatibility).
        let account_name = if file.account_name.is_empty() {
            path.file_stem().and_then(|s| s.to_str()).unwrap_or("default").to_string()
        } else {
            file.account_name
        };

        Ok(Self { signing_key, verifying_key, x25519_secret, x25519_public, username: file.username, avatar: file.avatar, bio: file.bio, account_name, path: path.to_path_buf() })
    }

    /// Persist the identity to disk.
    ///
    /// Uses an atomic write: we write to a `.tmp` file first, then rename it
    /// over the real file.  On UNIX the rename is atomic, so a crash mid-write
    /// cannot corrupt an existing valid identity file.
    ///
    /// On UNIX the file is also chmod 0600 so other users on the machine
    /// cannot read the private key seed.
    pub fn save_to_file(&self) -> Result<()> {
        let path = &self.path;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| P2pError::Identity(format!("cannot create config dir: {e}")))?;
        }
        let file = IdentityFile {
            ed25519_seed: B64.encode(self.signing_key.as_bytes()),
            x25519_secret: B64.encode(self.x25519_secret.as_bytes()),
            username: self.username.clone(),
            account_name: self.account_name.clone(),
            avatar: self.avatar.clone(),
            bio: self.bio.clone(),
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| P2pError::Identity(format!("cannot serialise identity: {e}")))?;
        // Atomic write: write to temp file then rename.
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &json)
            .map_err(|e| P2pError::Identity(format!("cannot write identity file: {e}")))?;
        std::fs::rename(&tmp, path)
            .map_err(|e| P2pError::Identity(format!("cannot rename identity file: {e}")))?;
        // Restrict read access to the owner only (private key material).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| P2pError::Identity(format!("cannot set file permissions: {e}")))?;
        }
        Ok(())
    }

    /// Return the Ed25519 public key as a base64 string.  This is the primary
    /// identifier for a peer across the network.
    pub fn pubkey_b64(&self) -> PubKeyB64 { B64.encode(self.verifying_key.as_bytes()) }

    /// Return the X25519 public key as a base64 string.  Shared in Hello
    /// messages so other peers can encrypt DMs to us.
    pub fn x25519_pubkey_b64(&self) -> PubKeyB64 { B64.encode(self.x25519_public.as_bytes()) }

    /// Return the human-readable fingerprint: the first 8 bytes of the
    /// SHA-256 hash of the public key, formatted as colon-separated uppercase
    /// hex (e.g. "A1:B2:C3:D4:E5:F6:07:08").
    pub fn fingerprint(&self) -> Fingerprint { pubkey_fingerprint(self.verifying_key.as_bytes()) }

    /// Display name: username if set, fingerprint otherwise.
    pub fn display_name(&self) -> String { self.username.clone().unwrap_or_else(|| self.fingerprint()) }

    /// Print a summary of this identity to stdout (used by the `whoami` command).
    pub fn print_info(&self) {
        println!("━━ Identity: {} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", self.account_name);
        println!("  Username    : {}", self.display_name());
        println!("  Public key  : {}", self.pubkey_b64());
        println!("  Fingerprint : {}", self.fingerprint());
        println!("  Config path : {}", self.path.display());
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    }
}

// ── Path helpers ──────────────────────────────────────────────────────────────

/// Base directory for all agora configuration.
/// Respects `$XDG_CONFIG_HOME`; falls back to platform-specific locations.
fn config_base() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") { return PathBuf::from(xdg); }
    #[cfg(unix)] { if let Ok(home) = std::env::var("HOME") { return PathBuf::from(home).join(".config"); } }
    #[cfg(windows)] { if let Ok(p) = std::env::var("APPDATA") { return PathBuf::from(p); } }
    PathBuf::from(".")
}

/// Directory where all identity JSON files are stored.
fn identities_dir() -> Result<PathBuf> { Ok(config_base().join("agora").join("identities")) }

/// Path for a specific identity file.
/// Account names are sanitised: only alphanumerics, `-`, and `_` are allowed;
/// everything else is replaced with `_` to prevent path traversal.
pub fn identity_path(name: &str) -> Result<PathBuf> {
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    Ok(identities_dir()?.join(format!("{}.json", safe)))
}

/// Path to the file that records which identity is currently active.
/// Contains just the account name as plain text.
fn active_identity_file() -> PathBuf { config_base().join("agora").join("active_identity") }

/// Read the active identity name from disk.
///
/// Also handles a one-time legacy migration: if there is an `identity.json`
/// at the old single-identity path but no `active_identity` marker, we copy
/// the file to `identities/default.json` and set the active name to "default".
/// This lets existing users upgrade without losing their identity.
pub fn active_identity_name() -> Result<Option<String>> {
    let p = active_identity_file();
    if !p.exists() {
        // Legacy migration: if old single identity.json exists, treat as "default"
        let legacy = config_base().join("agora").join("identity.json");
        if legacy.exists() {
            let dest_dir = identities_dir()?;
            std::fs::create_dir_all(&dest_dir).ok();
            let dest = dest_dir.join("default.json");
            std::fs::copy(&legacy, &dest).ok();
            set_active_identity("default").ok();
            return Ok(Some("default".into()));
        }
        return Ok(None);
    }
    let s = std::fs::read_to_string(&p).map_err(|e| P2pError::Identity(e.to_string()))?;
    Ok(Some(s.trim().to_string()))
}

/// Write the active identity name to disk.
pub fn set_active_identity(name: &str) -> Result<()> {
    let p = active_identity_file();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| P2pError::Identity(e.to_string()))?;
    }
    std::fs::write(&p, name).map_err(|e| P2pError::Identity(e.to_string()))
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

/// Derive an X25519 static secret from an Ed25519 seed using a
/// domain-separated SHA-256 hash.
///
/// We use the Ed25519 seed as input material rather than the X25519 secret
/// directly so that backing up the Ed25519 seed is sufficient to recover both
/// keys.  The domain string `"agora-x25519-derive-v1"` ensures the derived
/// value is unique to this purpose and won't collide with any other use of the
/// same seed bytes.
fn derive_x25519_secret(ed25519_seed: &[u8]) -> X25519Secret {
    let mut hasher = Sha256::new();
    hasher.update(b"agora-x25519-derive-v1");
    hasher.update(ed25519_seed);
    let bytes: [u8; 32] = hasher.finalize().into();
    X25519Secret::from(bytes)
}

/// Compute a human-readable fingerprint from a raw public key.
///
/// Takes the SHA-256 hash of the key bytes and formats the first 8 bytes as
/// colon-separated uppercase hex.  The result looks like:
///   `A1:B2:C3:D4:E5:F6:07:08`
/// (23 characters including colons).
///
/// This is used for display purposes so users can verify peer identity out-of-band
/// without having to compare full base64 public keys.
pub fn pubkey_fingerprint(raw: &[u8]) -> Fingerprint {
    let hash = Sha256::digest(raw);
    hash[..8].iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// Decode a base64-encoded Ed25519 verifying (public) key.
/// Returns an error if the base64 is invalid or the key bytes are malformed.
pub fn verifying_key_from_b64(b64: &str) -> Result<VerifyingKey> {
    let bytes = B64.decode(b64).map_err(|e| P2pError::Crypto(format!("bad base64 pubkey: {e}")))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| P2pError::Crypto("pubkey must be 32 bytes".into()))?;
    VerifyingKey::from_bytes(&arr).map_err(|e| P2pError::Crypto(format!("invalid Ed25519 pubkey: {e}")))
}

/// Decode a base64-encoded X25519 public key.
/// Returns an error if the base64 is invalid or the key is not 32 bytes.
pub fn x25519_public_from_b64(b64: &str) -> Result<x25519_dalek::PublicKey> {
    let bytes = B64.decode(b64).map_err(|e| P2pError::Crypto(format!("bad base64 x25519 pubkey: {e}")))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| P2pError::Crypto("x25519 pubkey must be 32 bytes".into()))?;
    Ok(x25519_dalek::PublicKey::from(arr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_roundtrip() {
        // Generate a key, encode the public half, decode it, and compare bytes.
        let id = Identity::generate(PathBuf::from("/tmp/test_id.json"), "test".into());
        let b64 = id.pubkey_b64();
        let decoded = verifying_key_from_b64(&b64).unwrap();
        assert_eq!(decoded.as_bytes(), id.verifying_key.as_bytes());
    }

    #[test]
    fn fingerprint_stable() {
        // The fingerprint must be deterministic and have the expected length.
        let id = Identity::generate(PathBuf::from("/tmp/test_id2.json"), "test".into());
        assert_eq!(id.fingerprint(), id.fingerprint());
        // 8 bytes × 2 hex chars + 7 colons = 23 characters.
        assert_eq!(id.fingerprint().len(), 23);
    }

    #[test]
    fn username_persists() {
        // Save an identity with a username, reload it, verify the username survived.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("alice.json");
        let mut id = Identity::generate(path.clone(), "alice".into());
        id.username = Some("alice".into());
        id.save_to_file().unwrap();
        let loaded = Identity::load_from_file(&path).unwrap();
        assert_eq!(loaded.username, Some("alice".into()));
        assert_eq!(loaded.account_name, "alice");
    }
}
