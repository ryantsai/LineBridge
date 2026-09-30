use crate::error::{BridgeError, Result};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::{fs, path::Path};
use zeroize::Zeroizing;

pub struct Vault {
    key: Zeroizing<[u8; 32]>,
}
pub fn random<const N: usize>() -> Result<[u8; N]> {
    let mut b = [0; N];
    getrandom::fill(&mut b).map_err(|_| BridgeError::storage())?;
    Ok(b)
}
impl Vault {
    pub fn open(data: &Path) -> Result<Self> {
        fs::create_dir_all(data).map_err(|_| BridgeError::storage())?;
        let path = data.join(if cfg!(windows) {
            "vault-key.dpapi"
        } else {
            "vault-key.bin"
        });
        if !path.exists() {
            let key = random::<32>()?;
            let stored = protect(&key, false)?;
            use std::io::Write;
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|_| BridgeError::storage())?;
            f.write_all(&stored).map_err(|_| BridgeError::storage())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                f.set_permissions(fs::Permissions::from_mode(0o600))
                    .map_err(|_| BridgeError::storage())?;
            }
        }
        let stored = fs::read(path).map_err(|_| BridgeError::storage())?;
        let plain = Zeroizing::new(protect(&stored, true)?);
        let key = <[u8; 32]>::try_from(plain.as_slice()).map_err(|_| BridgeError::storage())?;
        Ok(Self {
            key: Zeroizing::new(key),
        })
    }
    pub fn seal(&self, value: &Value, context: &str) -> Result<String> {
        let nonce = random::<12>()?;
        let plain = Zeroizing::new(serde_json::to_vec(value).map_err(|_| BridgeError::storage())?);
        let encrypted = Aes256Gcm::new_from_slice(self.key.as_ref())
            .map_err(|_| BridgeError::storage())?
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &plain,
                    aad: context.as_bytes(),
                },
            )
            .map_err(|_| BridgeError::storage())?;
        let split = encrypted.len() - 16;
        // Preserve the existing Node vault format: nonce || tag || ciphertext.
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&encrypted[split..]);
        blob.extend_from_slice(&encrypted[..split]);
        Ok(STANDARD.encode(blob))
    }
    pub fn unseal(&self, cipher: &str, context: &str) -> Result<Value> {
        let b = STANDARD
            .decode(cipher)
            .map_err(|_| BridgeError::storage())?;
        if b.len() < 28 {
            return Err(BridgeError::storage());
        }
        let mut encrypted = b[28..].to_vec();
        encrypted.extend_from_slice(&b[12..28]);
        let plain = Zeroizing::new(
            Aes256Gcm::new_from_slice(self.key.as_ref())
                .map_err(|_| BridgeError::storage())?
                .decrypt(
                    &Nonce::from(
                        <[u8; 12]>::try_from(&b[..12]).map_err(|_| BridgeError::storage())?,
                    ),
                    Payload {
                        msg: &encrypted,
                        aad: context.as_bytes(),
                    },
                )
                .map_err(|_| BridgeError::storage())?,
        );
        serde_json::from_slice(&plain).map_err(|_| BridgeError::storage())
    }
    pub fn key(&self) -> &[u8] {
        self.key.as_ref()
    }
    pub fn protection(&self) -> &'static str {
        if cfg!(windows) {
            "Windows DPAPI + AES-256-GCM"
        } else {
            "File permissions + AES-256-GCM"
        }
    }
}

#[cfg(windows)]
fn protect(input: &[u8], unprotect: bool) -> Result<Vec<u8>> {
    use std::ffi::c_void;
    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    let input = Blob {
        len: input.len() as u32,
        data: input.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        len: 0,
        data: std::ptr::null_mut(),
    };
    // Windows allocates the output; copy it, clear it and release it with LocalFree.
    unsafe {
        let ok = if unprotect {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(BridgeError::new(
                500,
                "vault_locked",
                "Cannot unlock the credential vault for this Windows user.",
            ));
        }
        let bytes = std::slice::from_raw_parts_mut(output.data, output.len as usize);
        let result = bytes.to_vec();
        bytes.fill(0);
        LocalFree(output.data as *mut c_void);
        Ok(result)
    }
}
#[cfg(not(windows))]
fn protect(input: &[u8], _: bool) -> Result<Vec<u8>> {
    Ok(input.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vault_roundtrip_binding_and_restart() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let v = serde_json::json!({"auth":"private","counter":{"$bigint":"123"}});
        let cipher = vault.seal(&v, "account:key").unwrap();
        assert!(!cipher.contains("private"));
        assert_eq!(
            Vault::open(dir.path())
                .unwrap()
                .unseal(&cipher, "account:key")
                .unwrap(),
            v
        );
        assert!(vault.unseal(&cipher, "other:key").is_err());
    }
}
