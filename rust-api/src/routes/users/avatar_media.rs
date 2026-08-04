//! Avatar byte validation.
//!
//! The generic `/v2/upload` handler decides file type from the browser-supplied `content_type`,
//! which any client can set freely, and enforces no size limit of its own. Avatars are a
//! self-service surface open to every staff role, so they decide from the bytes themselves and
//! carry their own cap rather than relying on the nginx and gateway limits in front.

/// 2MB. The gateway's multipart plugin caps at 5MB, which is far too generous for a 40px avatar.
pub(super) const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum AvatarImageKind {
    Jpeg,
    Png,
    WebP,
}

impl AvatarImageKind {
    /// Extension is derived from the detected content, never from the uploaded filename.
    pub(super) fn extension(&self) -> &'static str {
        match self {
            AvatarImageKind::Jpeg => "jpg",
            AvatarImageKind::Png => "png",
            AvatarImageKind::WebP => "webp",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum AvatarMediaError {
    Empty,
    TooLarge,
    UnsupportedFormat,
}

const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

pub(super) fn detect_avatar_image(bytes: &[u8]) -> Result<AvatarImageKind, AvatarMediaError> {
    if bytes.is_empty() {
        return Err(AvatarMediaError::Empty);
    }
    if bytes.len() > MAX_AVATAR_BYTES {
        return Err(AvatarMediaError::TooLarge);
    }
    if bytes.starts_with(&PNG_MAGIC) {
        return Ok(AvatarImageKind::Png);
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Ok(AvatarImageKind::Jpeg);
    }
    // WebP is a RIFF container; the fourcc at offset 8 separates it from WAV and AVI.
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Ok(AvatarImageKind::WebP);
    }
    Err(AvatarMediaError::UnsupportedFormat)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(len: usize) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0];
        bytes.resize(len.max(4), 0x00);
        bytes
    }

    fn png(len: usize) -> Vec<u8> {
        let mut bytes = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.resize(len.max(8), 0x00);
        bytes
    }

    fn webp(len: usize) -> Vec<u8> {
        let mut bytes = Vec::from(b"RIFF\0\0\0\0WEBPVP8 ".as_slice());
        bytes.resize(len.max(16), 0x00);
        bytes
    }

    #[test]
    fn accepts_the_three_supported_formats_and_maps_their_extensions() {
        assert_eq!(detect_avatar_image(&jpeg(64)), Ok(AvatarImageKind::Jpeg));
        assert_eq!(detect_avatar_image(&png(64)), Ok(AvatarImageKind::Png));
        assert_eq!(detect_avatar_image(&webp(64)), Ok(AvatarImageKind::WebP));
        assert_eq!(AvatarImageKind::Jpeg.extension(), "jpg");
        assert_eq!(AvatarImageKind::Png.extension(), "png");
        assert_eq!(AvatarImageKind::WebP.extension(), "webp");
    }

    #[test]
    fn rejects_gif_even_though_the_generic_upload_path_allows_it() {
        let gif = b"GIF89a\0\0\0\0\0\0\0\0\0\0".to_vec();
        assert_eq!(
            detect_avatar_image(&gif),
            Err(AvatarMediaError::UnsupportedFormat)
        );
    }

    // The generic upload handler trusts the browser-supplied content_type, so a
    // renamed executable passes. Avatars decide from the bytes instead.
    #[test]
    fn rejects_content_that_only_claims_to_be_an_image() {
        let disguised = b"MZ\x90\x00\x03\x00\x00\x00payload".to_vec();
        assert_eq!(
            detect_avatar_image(&disguised),
            Err(AvatarMediaError::UnsupportedFormat)
        );
    }

    #[test]
    fn rejects_riff_containers_that_are_not_webp() {
        let mut wav = Vec::from(b"RIFF\0\0\0\0WAVEfmt ".as_slice());
        wav.resize(64, 0x00);
        assert_eq!(
            detect_avatar_image(&wav),
            Err(AvatarMediaError::UnsupportedFormat)
        );
    }

    #[test]
    fn rejects_anything_larger_than_two_megabytes() {
        assert_eq!(MAX_AVATAR_BYTES, 2 * 1024 * 1024);
        assert_eq!(
            detect_avatar_image(&png(MAX_AVATAR_BYTES + 1)),
            Err(AvatarMediaError::TooLarge)
        );
        assert!(detect_avatar_image(&png(MAX_AVATAR_BYTES)).is_ok());
    }

    #[test]
    fn rejects_an_empty_body() {
        assert_eq!(detect_avatar_image(&[]), Err(AvatarMediaError::Empty));
    }

    // Truncated headers must not panic on slice indexing.
    #[test]
    fn rejects_truncated_headers_without_panicking() {
        assert_eq!(
            detect_avatar_image(&[0xFF, 0xD8]),
            Err(AvatarMediaError::UnsupportedFormat)
        );
        assert_eq!(
            detect_avatar_image(b"RIFF"),
            Err(AvatarMediaError::UnsupportedFormat)
        );
    }
}
