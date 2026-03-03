use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub fn resolve_runtime_base_dir() -> napi::Result<PathBuf> {
    if let Some(module_dir) = crate::get_native_module_dir() {
        return Ok(module_dir.clone());
    }

    env::current_dir().map_err(|e| {
        napi::Error::from_reason(format!("Failed to get current working directory: {}", e))
    })
}

pub fn resolve_dcm2niix_path(base_dir: &Path) -> napi::Result<PathBuf> {
    #[cfg(target_os = "macos")]
    let relative_binary = PathBuf::from("tools")
        .join("macos-arm64")
        .join("dcm2niix")
        .join("dcm2niix");

    #[cfg(target_os = "windows")]
    let relative_binary = PathBuf::from("tools")
        .join("windows-x64")
        .join("dcm2niix")
        .join("dcm2niix.exe");

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return Err(napi::Error::from_reason(
            "NIfTI export (type=2) is only supported on macOS and Windows.".to_string(),
        ));
    }

    let candidate = base_dir.join(&relative_binary);
    if candidate.exists() {
        return Ok(candidate);
    }

    Err(napi::Error::from_reason(format!(
    "dcm2niix binary not found at '{}' (base='{}'). macOS expects 'tools/macos-arm64/dcm2niix/dcm2niix', Windows expects 'tools/windows-x64/dcm2niix/dcm2niix.exe'.",
    candidate.to_string_lossy(),
    base_dir.to_string_lossy()
  )))
}

pub fn resolve_dcmdjpeg_path(base_dir: &Path) -> napi::Result<PathBuf> {
    #[cfg(target_os = "macos")]
    let relative_binary = PathBuf::from("tools")
        .join("macos-arm64")
        .join("dcmtk-3.7.0")
        .join("bin")
        .join("dcmdjpeg");

    #[cfg(target_os = "windows")]
    let relative_binary = PathBuf::from("tools")
        .join("windows-x64")
        .join("dcmtk-3.7.0")
        .join("bin")
        .join("dcmdjpeg.exe");

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return Err(napi::Error::from_reason(
            "NIfTI export (type=2) is only supported on macOS and Windows.".to_string(),
        ));
    }

    let candidate = base_dir.join(&relative_binary);
    if candidate.exists() {
        return Ok(candidate);
    }

    Err(napi::Error::from_reason(format!(
    "dcmdjpeg binary not found at '{}' (base='{}'). macOS expects 'tools/macos-arm64/dcmtk-3.7.0/bin/dcmdjpeg', Windows expects 'tools/windows-x64/dcmtk-3.7.0/bin/dcmdjpeg.exe'.",
    candidate.to_string_lossy(),
    base_dir.to_string_lossy()
  )))
}

pub fn resolve_dcm2img_path(base_dir: &Path) -> napi::Result<PathBuf> {
    #[cfg(target_os = "macos")]
    let relative_binary = PathBuf::from("tools")
        .join("macos-arm64")
        .join("dcmtk-3.7.0")
        .join("bin")
        .join("dcm2img");

    #[cfg(target_os = "windows")]
    let relative_binary = PathBuf::from("tools")
        .join("windows-x64")
        .join("dcmtk-3.7.0")
        .join("bin")
        .join("dcm2img.exe");

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return Err(napi::Error::from_reason(
            "JPEG export (type=3) is only supported on macOS and Windows.".to_string(),
        ));
    }

    let candidate = base_dir.join(&relative_binary);
    if candidate.exists() {
        return Ok(candidate);
    }

    Err(napi::Error::from_reason(format!(
    "dcm2img binary not found at '{}' (base='{}'). macOS expects 'tools/macos-arm64/dcmtk-3.7.0/bin/dcm2img', Windows expects 'tools/windows-x64/dcmtk-3.7.0/bin/dcm2img.exe'.",
    candidate.to_string_lossy(),
    base_dir.to_string_lossy()
  )))
}

pub fn resolve_ffmpeg_path(base_dir: &Path) -> napi::Result<PathBuf> {
    #[cfg(target_os = "macos")]
    let relative_binary = PathBuf::from("tools")
        .join("macos-arm64")
        .join("ffmpeg")
        .join("ffmpeg");

    #[cfg(target_os = "windows")]
    let relative_binary = PathBuf::from("tools")
        .join("windows-x64")
        .join("ffmpeg")
        .join("bin")
        .join("ffmpeg.exe");

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return Err(napi::Error::from_reason(
            "MP4 export (type=4) is only supported on macOS and Windows.".to_string(),
        ));
    }

    let candidate = base_dir.join(&relative_binary);
    if candidate.exists() {
        return Ok(candidate);
    }

    Err(napi::Error::from_reason(format!(
    "ffmpeg binary not found at '{}' (base='{}'). macOS expects 'tools/macos-arm64/ffmpeg/ffmpeg', Windows expects 'tools/windows-x64/ffmpeg/bin/ffmpeg.exe'.",
    candidate.to_string_lossy(),
    base_dir.to_string_lossy()
  )))
}

pub fn resolve_dcmdjpeg_dictionary_path(dcmdjpeg_path: &Path) -> napi::Result<PathBuf> {
    let dcmtk_root = dcmdjpeg_path
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| {
            napi::Error::from_reason(format!(
                "Failed to resolve DCMTK root from dcmdjpeg path '{}'",
                dcmdjpeg_path.to_string_lossy()
            ))
        })?;

    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        candidates.push(
            dcmtk_root
                .join("share")
                .join("dcmtk-3.7.0")
                .join("dicom.dic"),
        );
        candidates.push(dcmtk_root.join("etc").join("dcmtk-3.7.0").join("dicom.dic"));
    }

    #[cfg(target_os = "windows")]
    {
        candidates.push(
            dcmtk_root
                .join("share")
                .join("dcmtk-3.7.0")
                .join("dicom.dic"),
        );
        candidates.push(dcmtk_root.join("etc").join("dcmtk-3.7.0").join("dicom.dic"));
    }

    candidates.push(dcmtk_root.join("share").join("dicom.dic"));
    candidates.push(dcmtk_root.join("etc").join("dicom.dic"));

    for base in ["share", "etc"] {
        let base_dir = dcmtk_root.join(base);
        if !base_dir.exists() {
            continue;
        }

        if let Ok(entries) = fs::read_dir(&base_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    candidates.push(path.join("dicom.dic"));
                }
            }
        }
    }

    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(napi::Error::from_reason(format!(
    "DCMTK dictionary file 'dicom.dic' not found under '{}'. Please ensure the bundled dcmtk directory includes share/*/dicom.dic or etc/*/dicom.dic.",
    dcmtk_root.to_string_lossy()
  )))
}
