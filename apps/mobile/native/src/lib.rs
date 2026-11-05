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
    /// Offers a file to the rest of the phone: save to Files, AirDrop, another app. False where
    /// there is no share sheet.
    pub fn file(path: String) -> bool {
        #[cfg(target_os = "ios")]
        {
            ios::share(path);
            return true;
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = path;
            false
        }
    }
}
