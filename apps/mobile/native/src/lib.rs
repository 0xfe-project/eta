//! What the app needs of the phone that TSX cannot reach: the camera, to scan the code the desktop
//! shows. Imported as `eta/native`.

use nsh_core::prelude::*;

#[cfg(target_os = "ios")]
mod ios;

#[native_module("eta/native")]
fn native(registry: &mut Registry) {
    registry.module::<Scanner>().module::<Sharing>();
}

/// The camera, as a QR code reader.
#[module]
pub struct Scanner;

#[module]
impl Scanner {
    /// Whether this device has a camera to scan with.
    pub fn available() -> bool {
        #[cfg(target_os = "ios")]
        return ios::available();
        #[cfg(not(target_os = "ios"))]
        false
    }

    /// Opens the camera over the app; resolves with the code's text, or null when it was closed.
    pub async fn scan() -> Option<String> {
        #[cfg(target_os = "ios")]
        {
            let answer = ios::scan();
            return blocking(move || answer.recv().ok().flatten()).await.ok().flatten();
        }
        #[cfg(not(target_os = "ios"))]
        None
    }
}

/// The system's share sheet.
#[module]
pub struct Sharing;

#[module]
impl Sharing {
    /// Fetches a file (with these headers) into the temporary directory and offers it to the rest
    /// of the phone: save to Files, AirDrop, another app. Rejects with why it could not.
    pub async fn download(
        url: String,
        name: String,
        token: Option<String>,
    ) -> Result<(), String> {
        let mut request = HttpRequest::get(url);
        if let Some(token) = token {
            request = request.header("X-Eta-Token", token);
        }
        let response = fetch(request).await?;
        if !response.ok() {
            return Err(format!("HTTP {}", response.status()));
        }
        // The name comes from the host: keep only its last part.
        let name = name.rsplit('/').next().unwrap_or("download");
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, &response.body).map_err(|error| error.to_string())?;
        #[cfg(target_os = "ios")]
        {
            ios::share(path.to_string_lossy().into_owned());
            return Ok(());
        }
        #[cfg(not(target_os = "ios"))]
        Err("no share sheet here".to_owned())
    }
}
