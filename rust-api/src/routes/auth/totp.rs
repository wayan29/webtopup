use hmac::{Hmac, Mac};
use rand::Rng;
use sha1::Sha1;

use super::now_seconds;

pub(super) fn normalize_otp_code(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .split_whitespace()
        .collect::<String>()
}

pub(super) fn generate_totp_secret() -> String {
    const BASE32_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| BASE32_ALPHABET[rng.gen_range(0..BASE32_ALPHABET.len())] as char)
        .collect()
}

pub(super) fn is_valid_totp_code(code: &str, secret: &str) -> bool {
    let Ok(secret_bytes) = decode_base32(secret) else {
        return false;
    };
    if code.len() != 6 || !code.chars().all(|value| value.is_ascii_digit()) {
        return false;
    }
    // Accept ±2 steps (30s each) so a code that just rolled on the phone still matches when
    // the phone clock is a few dozen seconds ahead/behind the server. ±1 is the RFC minimum;
    // ±2 is common for enrollment UX without meaningfully weakening brute-force resistance
    // (still only ~5 codes valid at once, rate-limited by step-up / confirm handlers).
    let counter = (now_seconds() as i64) / 30;
    (-2..=2).any(|offset| totp_code(&secret_bytes, counter + offset) == code)
}

pub(super) fn url_encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

fn totp_code(secret: &[u8], counter: i64) -> String {
    type HmacSha1 = Hmac<Sha1>;
    let counter = counter.max(0) as u64;
    let mut mac = match HmacSha1::new_from_slice(secret) {
        Ok(value) => value,
        Err(_) => return String::new(),
    };
    mac.update(&counter.to_be_bytes());
    let result = mac.finalize().into_bytes();
    let offset = (result[19] & 0x0f) as usize;
    let binary = (((result[offset] & 0x7f) as u32) << 24)
        | ((result[offset + 1] as u32) << 16)
        | ((result[offset + 2] as u32) << 8)
        | (result[offset + 3] as u32);
    format!("{:06}", binary % 1_000_000)
}

fn decode_base32(secret: &str) -> Result<Vec<u8>, ()> {
    let mut bits = 0_u32;
    let mut value = 0_u32;
    let mut output = Vec::new();
    for ch in secret
        .chars()
        .filter(|ch| *ch != '=' && !ch.is_whitespace())
    {
        let digit = match ch.to_ascii_uppercase() {
            'A'..='Z' => ch.to_ascii_uppercase() as u8 - b'A',
            '2'..='7' => ch as u8 - b'2' + 26,
            _ => return Err(()),
        } as u32;
        value = (value << 5) | digit;
        bits += 5;
        if bits >= 8 {
            output.push(((value >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    if output.is_empty() {
        return Err(());
    }
    Ok(output)
}
