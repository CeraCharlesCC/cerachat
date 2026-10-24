use base64::{engine::general_purpose::STANDARD, Engine};

use crate::{
    error::{AppError, AppResult},
    models::ImageAttachment,
};

pub const MAX_IMAGES: usize = 4;
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_REQUEST_IMAGE_URL_BYTES: usize = 28 * 1024 * 1024;

pub fn validate(images: &[ImageAttachment]) -> AppResult<()> {
    if images.len() > MAX_IMAGES {
        return Err(AppError::Message(
            "Attach at most 4 images per message.".into(),
        ));
    }
    for image in images {
        if image.name.trim().is_empty() || image.name.len() > 1024 {
            return Err(AppError::Message(
                "Image name must contain 1–1024 bytes.".into(),
            ));
        }
        if image.data_url.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 + 64 {
            return Err(AppError::Message(
                "Each image must be at most 5 MiB.".into(),
            ));
        }
        let (header, encoded) = image
            .data_url
            .split_once(',')
            .ok_or_else(|| AppError::Message("Invalid image data URL.".into()))?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| AppError::Message("Invalid image base64.".into()))?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err(AppError::Message(
                "Each image must contain 1 byte to 5 MiB.".into(),
            ));
        }
        let valid = match header {
            "data:image/png;base64" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "data:image/jpeg;base64" => bytes.starts_with(b"\xff\xd8\xff"),
            "data:image/webp;base64" => {
                bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
            }
            _ => false,
        };
        if !valid {
            return Err(AppError::Message(
                "Use PNG, JPEG, or WebP images with matching file contents.".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_remote_urls_invalid_base64_mismatched_formats_and_oversized_images() {
        let image = |data_url: String| ImageAttachment {
            name: "image.png".into(),
            data_url,
        };
        for url in [
            "https://example.test/private.png",
            "data:image/svg+xml;base64,PHN2Zy8+",
            "data:image/png;base64,!!!!",
            "data:image/png;base64,aGVsbG8=",
        ] {
            assert!(validate(&[image(url.into())]).is_err());
        }
        let png = image(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(b"\x89PNG\r\n\x1a\n")
        ));
        validate(std::slice::from_ref(&png)).unwrap();
        assert!(validate(&vec![png; MAX_IMAGES + 1]).is_err());
        assert!(validate(&[image(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(vec![0; MAX_IMAGE_BYTES + 1])
        ))])
        .is_err());
    }
}
