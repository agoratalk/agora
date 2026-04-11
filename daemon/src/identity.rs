//! Identity management: multi-account Ed25519 + X25519 keypairs, persistence, username.
//!
//! Identities live in ~/.config/agora/identities/<name>.json
//! The active identity is tracked in ~/.config/agora/active_identity

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as X25519Public, StaticSecret as X25519Secret};

use crate::types::{Fingerprint, P2pError, PubKeyB64, Result};

#[derive(Serialize, Deserialize)]
struct IdentityFile {
    ed25519_seed: String,
    x25519_secret: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub account_name: String,
    /// Base64-encoded avatar image data URL
    #[serde(default)]
    pub avatar: Option<String>,
}

pub struct Identity {
    pub signing_key: SigningKey,
    pub verifying_key: VerifyingKey,
    pub x25519_secret: X25519Secret,
    pub x25519_public: X25519Public,
    pub username: Option<String>,
    pub account_name: String,
    /// Base64-encoded avatar image data URL (e.g. "data:image/jpeg;base64,...")
    pub avatar: Option<String>,
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentitySummary {
    pub account_name: String,
    pub username: Option<String>,
    pub fingerprint: String,
    pub pubkey: String,
    pub is_active: bool,
    pub avatar: Option<String>,
}

impl Identity {
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
            set_active_identity(name)?;
            tracing::info!("identity saved to {}", path.display());
            Ok(id)
        }
    }

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

    pub fn switch_to(name: &str) -> Result<Self> {
        set_active_identity(name)?;
        Self::load_or_create_named(name)
    }

    pub fn list_identities() -> Result<Vec<IdentitySummary>> {
        let dir = identities_dir()?;
        if !dir.exists() { return Ok(vec![]); }
        let active = active_identity_name()?.unwrap_or_default();
        let mut result = vec![];
        for entry in std::fs::read_dir(&dir).map_err(|e| P2pError::Identity(e.to_string()))? {
            let entry = entry.map_err(|e| P2pError::Identity(e.to_string()))?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            if let Ok(id) = Self::load_from_file(&path) {
                result.push(IdentitySummary {
                    account_name: id.account_name.clone(),
                    username: id.username.clone(),
                    fingerprint: id.fingerprint(),
                    pubkey: id.pubkey_b64(),
                    is_active: id.account_name == active,
                    avatar: id.avatar.clone(),
                });
            }
        }
        result.sort_by(|a, b| a.account_name.cmp(&b.account_name));
        Ok(result)
    }

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

    pub fn generate(path: PathBuf, account_name: String) -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let x25519_secret = derive_x25519_secret(signing_key.as_bytes());
        let x25519_public = X25519Public::from(&x25519_secret);
        Self { signing_key, verifying_key, x25519_secret, x25519_public, username: None, avatar: None, account_name, path }
    }

    pub fn load_from_file(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| P2pError::Identity(format!("cannot read identity file: {e}")))?;
        let file: IdentityFile = serde_json::from_str(&raw)
            .map_err(|e| P2pError::Identity(format!("malformed identity file: {e}")))?;

        let seed_bytes = B64.decode(&file.ed25519_seed)
            .map_err(|e| P2pError::Identity(format!("bad base64 in ed25519_seed: {e}")))?;
        let seed: [u8; 32] = seed_bytes.try_into()
            .map_err(|_| P2pError::Identity("ed25519_seed must be 32 bytes".into()))?;
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();

        let x_bytes = B64.decode(&file.x25519_secret)
            .map_err(|e| P2pError::Identity(format!("bad base64 in x25519_secret: {e}")))?;
        let x_arr: [u8; 32] = x_bytes.try_into()
            .map_err(|_| P2pError::Identity("x25519_secret must be 32 bytes".into()))?;
        let x25519_secret = X25519Secret::from(x_arr);
        let x25519_public = X25519Public::from(&x25519_secret);

        let account_name = if file.account_name.is_empty() {
            path.file_stem().and_then(|s| s.to_str()).unwrap_or("default").to_string()
        } else {
            file.account_name
        };

        Ok(Self { signing_key, verifying_key, x25519_secret, x25519_public, username: file.username, avatar: file.avatar, account_name, path: path.to_path_buf() })
    }

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
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| P2pError::Identity(format!("cannot serialise identity: {e}")))?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &json)
            .map_err(|e| P2pError::Identity(format!("cannot write identity file: {e}")))?;
        std::fs::rename(&tmp, path)
            .map_err(|e| P2pError::Identity(format!("cannot rename identity file: {e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| P2pError::Identity(format!("cannot set file permissions: {e}")))?;
        }
        Ok(())
    }

    pub fn pubkey_b64(&self) -> PubKeyB64 { B64.encode(self.verifying_key.as_bytes()) }
    pub fn x25519_pubkey_b64(&self) -> PubKeyB64 { B64.encode(self.x25519_public.as_bytes()) }
    pub fn fingerprint(&self) -> Fingerprint { pubkey_fingerprint(self.verifying_key.as_bytes()) }
    pub fn display_name(&self) -> String { self.username.clone().unwrap_or_else(|| self.fingerprint()) }

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

fn config_base() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") { return PathBuf::from(xdg); }
    #[cfg(unix)] { if let Ok(home) = std::env::var("HOME") { return PathBuf::from(home).join(".config"); } }
    #[cfg(windows)] { if let Ok(p) = std::env::var("APPDATA") { return PathBuf::from(p); } }
    PathBuf::from(".")
}

fn identities_dir() -> Result<PathBuf> { Ok(config_base().join("agora").join("identities")) }

pub fn identity_path(name: &str) -> Result<PathBuf> {
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    Ok(identities_dir()?.join(format!("{}.json", safe)))
}

fn active_identity_file() -> PathBuf { config_base().join("agora").join("active_identity") }

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

pub fn set_active_identity(name: &str) -> Result<()> {
    let p = active_identity_file();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| P2pError::Identity(e.to_string()))?;
    }
    std::fs::write(&p, name).map_err(|e| P2pError::Identity(e.to_string()))
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

fn derive_x25519_secret(ed25519_seed: &[u8]) -> X25519Secret {
    let mut hasher = Sha256::new();
    hasher.update(b"agora-x25519-derive-v1");
    hasher.update(ed25519_seed);
    let bytes: [u8; 32] = hasher.finalize().into();
    X25519Secret::from(bytes)
}

pub fn pubkey_fingerprint(raw: &[u8]) -> Fingerprint {
    let hash = Sha256::digest(raw);
    hash[..8].iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

pub fn verifying_key_from_b64(b64: &str) -> Result<VerifyingKey> {
    let bytes = B64.decode(b64).map_err(|e| P2pError::Crypto(format!("bad base64 pubkey: {e}")))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| P2pError::Crypto("pubkey must be 32 bytes".into()))?;
    VerifyingKey::from_bytes(&arr).map_err(|e| P2pError::Crypto(format!("invalid Ed25519 pubkey: {e}")))
}

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
        let id = Identity::generate(PathBuf::from("/tmp/test_id.json"), "test".into());
        let b64 = id.pubkey_b64();
        let decoded = verifying_key_from_b64(&b64).unwrap();
        assert_eq!(decoded.as_bytes(), id.verifying_key.as_bytes());
    }

    #[test]
    fn fingerprint_stable() {
        let id = Identity::generate(PathBuf::from("/tmp/test_id2.json"), "test".into());
        assert_eq!(id.fingerprint(), id.fingerprint());
        assert_eq!(id.fingerprint().len(), 23);
    }

    #[test]
    fn username_persists() {
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
