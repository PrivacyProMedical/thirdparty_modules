#![deny(clippy::all)]

mod export_standard_directory;
mod tools_path;
mod dicom_deidentification {
    pub mod dicom_deidentification;
}

use napi::bindgen_prelude::{JsValue, Object};
use napi_derive::napi;
use std::path::PathBuf;
use std::sync::OnceLock;

static NATIVE_MODULE_DIR: OnceLock<PathBuf> = OnceLock::new();

#[allow(dead_code)]
fn module_file_name_to_path(module_file_name: &str) -> PathBuf {
    if let Some(rest) = module_file_name.strip_prefix("file://") {
        #[cfg(target_os = "windows")]
        {
            let normalized = rest.strip_prefix('/').unwrap_or(rest).replace('/', "\\");
            return PathBuf::from(normalized);
        }

        #[cfg(not(target_os = "windows"))]
        {
            return PathBuf::from(rest);
        }
    }

    PathBuf::from(module_file_name)
}

#[napi(module_exports)]
#[allow(dead_code)]
fn init_module(exports: Object<'_>) -> napi::Result<()> {
    let env = napi::Env::from_raw(exports.value().env);
    let module_file_name = env.get_module_file_name()?;
    let module_file_path = module_file_name_to_path(&module_file_name);

    if let Some(module_dir) = module_file_path.parent() {
        let _ = NATIVE_MODULE_DIR.set(module_dir.to_path_buf());
    }

    Ok(())
}

pub(crate) fn get_native_module_dir() -> Option<&'static PathBuf> {
    NATIVE_MODULE_DIR.get()
}

pub use dicom_deidentification::dicom_deidentification::*;
pub use export_standard_directory::*;
