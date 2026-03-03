use napi_derive::napi;
use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::dicom_deidentification::dicom_deidentification::deidentify_2d_dicom;
use crate::tools_path::{
    resolve_dcm2img_path, resolve_dcm2niix_path, resolve_dcmdjpeg_dictionary_path,
    resolve_dcmdjpeg_path, resolve_ffmpeg_path, resolve_runtime_base_dir,
};

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct ParsedDirectoryJson {
    #[serde(rename = "PatientName")]
    patient_name: String,
    studies: HashMap<String, StudyNode>,
    #[serde(rename = "studiesInOrder")]
    studies_in_order: Vec<KeyRef>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct KeyRef {
    key: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct StudyNode {
    #[serde(rename = "StudyDescription")]
    study_description: String,
    series: HashMap<String, SeriesNode>,
    #[serde(rename = "seriesInOrder")]
    series_in_order: Vec<KeyRef>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct SeriesNode {
    #[serde(rename = "SeriesDescription")]
    series_description: String,
    #[serde(rename = "SeriesNumber")]
    series_number: i64,
    instances: HashMap<String, InstanceNode>,
    #[serde(rename = "instancesInOrder")]
    instances_in_order: Vec<KeyRef>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct InstanceNode {
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "filePath")]
    file_path: String,
}

#[napi]
/// Exports a parsed standard directory JSON into a patient/study/series folder structure.
///
/// Export types:
/// - 0: Copy original DICOM files
/// - 1: De-identify and export DICOM files
/// - 2: Convert each series to NIfTI via dcmdjpeg + dcm2niix
/// - 3: Convert each instance to JPEG via dcm2img
/// - 4: Convert each series to MP4 via dcm2img (frames) + ffmpeg
pub fn export_parsed_standard_directory(
    json_utf8_content: String,
    export_root_dir: String,
    export_type: u32,
) -> napi::Result<String> {
    // Validate export root directory.
    let root_path = Path::new(&export_root_dir);
    if !root_path.exists() {
        return Err(napi::Error::from_reason(format!(
            "Export root directory does not exist: {}",
            export_root_dir
        )));
    }
    if !root_path.is_dir() {
        return Err(napi::Error::from_reason(format!(
            "Export root path is not a directory: {}",
            export_root_dir
        )));
    }

    let parsed: ParsedDirectoryJson = serde_json::from_str(&json_utf8_content).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse input JSON string: {}", e))
    })?;

    // Resolve runtime base directory for bundled external tools.
    let runtime_base_dir = resolve_runtime_base_dir()?;

    // Initialize tool contexts that may be reused across series.
    let dcm2img_ctx = if export_type == 3 || export_type == 4 {
        let dcm2img_path = resolve_dcm2img_path(&runtime_base_dir)?;
        let dcmtk_dict_path = resolve_dcmdjpeg_dictionary_path(&dcm2img_path)?;
        Some((dcm2img_path, dcmtk_dict_path))
    } else {
        None
    };

    let ffmpeg_path = if export_type == 4 {
        Some(resolve_ffmpeg_path(&runtime_base_dir)?)
    } else {
        None
    };

    // Main output hierarchy starts from patient directory.
    let patient_dir = create_unique_subdir(
        root_path,
        &non_empty_or_default(&parsed.patient_name, "Unknown Patient"),
    )?;

    // Traverse studies in stable order.
    for study_ref in &parsed.studies_in_order {
        let study = parsed.studies.get(&study_ref.key).ok_or_else(|| {
            napi::Error::from_reason(format!("Study key not found in studies: {}", study_ref.key))
        })?;

        let study_dir = create_unique_subdir(
            &patient_dir,
            &non_empty_or_default(&study.study_description, "Unknown Study"),
        )?;

        // Traverse series in stable order.
        for series_ref in &study.series_in_order {
            let series = study.series.get(&series_ref.key).ok_or_else(|| {
                napi::Error::from_reason(format!(
                    "Series key not found in series: {}",
                    series_ref.key
                ))
            })?;

            let series_dir_name = format!(
                "{} #{}",
                non_empty_or_default(&series.series_description, "Unknown Series"),
                series.series_number
            );

            let series_dir = create_unique_subdir(&study_dir, &series_dir_name)?;

            // Type 2: convert whole series to NIfTI and continue.
            if export_type == 2 {
                export_series_to_nifti(series, &series_dir, &runtime_base_dir)?;
                continue;
            }

            // Type 4: convert whole series to MP4 and continue.
            if export_type == 4 {
                let (dcm2img_path, dcmtk_dict_path) = dcm2img_ctx.as_ref().ok_or_else(|| {
                    napi::Error::from_reason(
                        "Failed to initialize dcm2img context for MP4 export".to_string(),
                    )
                })?;
                let ffmpeg_path = ffmpeg_path.as_ref().ok_or_else(|| {
                    napi::Error::from_reason(
                        "Failed to initialize ffmpeg context for MP4 export".to_string(),
                    )
                })?;

                export_series_to_mp4(
                    series,
                    &series_dir,
                    dcm2img_path,
                    dcmtk_dict_path,
                    ffmpeg_path,
                )?;
                continue;
            }

            // Types 0/1/3: process instance-by-instance.
            for instance_ref in &series.instances_in_order {
                let instance = series.instances.get(&instance_ref.key).ok_or_else(|| {
                    napi::Error::from_reason(format!(
                        "Instance key not found in instances: {}",
                        instance_ref.key
                    ))
                })?;

                let src = Path::new(&instance.file_path);
                if !src.exists() {
                    return Err(napi::Error::from_reason(format!(
                        "Source file does not exist: {}",
                        instance.file_path
                    )));
                }

                let dst = series_dir.join(&instance.file_name);
                match export_type {
                    0 => {
                        fs::copy(src, &dst).map_err(|e| {
                            napi::Error::from_reason(format!(
                                "Failed to copy file from '{}' to '{}': {}",
                                instance.file_path,
                                dst.to_string_lossy(),
                                e
                            ))
                        })?;
                    }
                    1 => {
                        let result = deidentify_2d_dicom(
                            instance.file_path.clone(),
                            dst.to_string_lossy().to_string(),
                        );
                        if result != 0 {
                            return Err(napi::Error::from_reason(format!(
                                "Failed to deidentify DICOM file '{}'",
                                instance.file_path
                            )));
                        }
                    }
                    3 => {
                        let (dcm2img_path, dcmtk_dict_path) =
                            dcm2img_ctx.as_ref().ok_or_else(|| {
                                napi::Error::from_reason(
                                    "Failed to initialize dcm2img context for JPEG export"
                                        .to_string(),
                                )
                            })?;

                        let base_name = Path::new(&instance.file_name)
                            .file_stem()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_else(|| {
                                non_empty_or_default(&instance.file_name, "instance")
                            });
                        let jpeg_file_name = format!("{}.jpg", base_name);
                        let jpeg_dst = series_dir.join(jpeg_file_name);

                        run_dcm2img_jpeg(dcm2img_path, dcmtk_dict_path, src, &jpeg_dst)?;
                    }
                    _ => {
                        return Err(napi::Error::from_reason(format!(
              "Invalid export type: {}. Use 0 for copy, 1 for deidentify export, 2 for NIfTI export, 3 for JPEG export, or 4 for MP4 export.",
              export_type
            )));
                    }
                }
            }
        }
    }

    Ok(patient_dir.to_string_lossy().to_string())
}

/// Converts one series to NIfTI by first normalizing DICOM files with dcmdjpeg,
/// then invoking dcm2niix on a temporary input directory.
fn export_series_to_nifti(
    series: &SeriesNode,
    series_dir: &Path,
    runtime_base_dir: &Path,
) -> napi::Result<()> {
    let temp_input_dir = create_temp_series_input_dir()?;
    let dcmdjpeg_path = resolve_dcmdjpeg_path(runtime_base_dir)?;
    let dcmdjpeg_dict_path = resolve_dcmdjpeg_dictionary_path(&dcmdjpeg_path)?;

    let convert_result = (|| -> napi::Result<()> {
        for (index, instance_ref) in series.instances_in_order.iter().enumerate() {
            let instance = series.instances.get(&instance_ref.key).ok_or_else(|| {
                napi::Error::from_reason(format!(
                    "Instance key not found in instances: {}",
                    instance_ref.key
                ))
            })?;

            let src = Path::new(&instance.file_path);
            if !src.exists() {
                return Err(napi::Error::from_reason(format!(
                    "Source file does not exist: {}",
                    instance.file_path
                )));
            }

            let temp_name = format!(
                "{:08}_{}",
                index,
                non_empty_or_default(&instance.file_name, "instance.dcm")
            );
            let temp_dst = temp_input_dir.join(temp_name);
            run_dcmdjpeg(&dcmdjpeg_path, &dcmdjpeg_dict_path, src, &temp_dst)?;
        }

        run_dcm2niix(&temp_input_dir, series_dir, runtime_base_dir)
    })();

    if temp_input_dir.exists() {
        let _ = fs::remove_dir_all(&temp_input_dir);
    }

    convert_result
}

/// Creates a unique temporary directory used as dcm2niix input for one series.
fn create_temp_series_input_dir() -> napi::Result<PathBuf> {
    let now_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let dir = env::temp_dir().join(format!(
        "pmtaro-dcm2niix-{}-{}",
        std::process::id(),
        now_nanos
    ));

    fs::create_dir_all(&dir).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to create temporary directory for NIfTI export '{}': {}",
            dir.to_string_lossy(),
            e
        ))
    })?;

    Ok(dir)
}

/// Creates a unique temporary directory for JPEG frame files used by MP4 export.
fn create_temp_series_frames_dir() -> napi::Result<PathBuf> {
    let now_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let dir = env::temp_dir().join(format!(
        "pmtaro-mp4-frames-{}-{}",
        std::process::id(),
        now_nanos
    ));

    fs::create_dir_all(&dir).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to create temporary directory for MP4 frames '{}': {}",
            dir.to_string_lossy(),
            e
        ))
    })?;

    Ok(dir)
}

/// Converts one series into a single MP4 file by generating ordered JPEG frames
/// with dcm2img and then encoding them with ffmpeg.
fn export_series_to_mp4(
    series: &SeriesNode,
    series_dir: &Path,
    dcm2img_path: &Path,
    dcmtk_dict_path: &Path,
    ffmpeg_path: &Path,
) -> napi::Result<()> {
    let temp_frames_dir = create_temp_series_frames_dir()?;

    let convert_result = (|| -> napi::Result<()> {
        for (index, instance_ref) in series.instances_in_order.iter().enumerate() {
            let instance = series.instances.get(&instance_ref.key).ok_or_else(|| {
                napi::Error::from_reason(format!(
                    "Instance key not found in instances: {}",
                    instance_ref.key
                ))
            })?;

            let src = Path::new(&instance.file_path);
            if !src.exists() {
                return Err(napi::Error::from_reason(format!(
                    "Source file does not exist: {}",
                    instance.file_path
                )));
            }

            let frame_dst = temp_frames_dir.join(format!("{:08}.jpg", index));
            run_dcm2img_jpeg(dcm2img_path, dcmtk_dict_path, src, &frame_dst)?;
        }

        let mp4_output = series_dir.join("series.mp4");
        run_ffmpeg_jpeg_to_mp4(ffmpeg_path, &temp_frames_dir, &mp4_output)
    })();

    if temp_frames_dir.exists() {
        let _ = fs::remove_dir_all(&temp_frames_dir);
    }

    convert_result
}

/// Runs dcm2niix to convert a DICOM directory into NIfTI outputs.
fn run_dcm2niix(input_dir: &Path, output_dir: &Path, runtime_base_dir: &Path) -> napi::Result<()> {
    let binary_path = resolve_dcm2niix_path(runtime_base_dir)?;

    let output = Command::new(&binary_path)
        .arg("-o")
        .arg(output_dir)
        .arg(input_dir)
        .output()
        .map_err(|e| {
            napi::Error::from_reason(format!(
                "Failed to execute dcm2niix '{}': {}",
                binary_path.to_string_lossy(),
                e
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(napi::Error::from_reason(format!(
            "dcm2niix failed (code: {:?})\nstdout: {}\nstderr: {}",
            output.status.code(),
            stdout,
            stderr
        )));
    }

    Ok(())
}

/// Runs dcmdjpeg to decompress/normalize a DICOM file.
fn run_dcmdjpeg(
    binary_path: &Path,
    dictionary_path: &Path,
    input_path: &Path,
    output_path: &Path,
) -> napi::Result<()> {
    let output = Command::new(binary_path)
        .env("DCMDICTPATH", dictionary_path)
        .arg(input_path)
        .arg(output_path)
        .output()
        .map_err(|e| {
            napi::Error::from_reason(format!(
                "Failed to execute dcmdjpeg '{}': {}",
                binary_path.to_string_lossy(),
                e
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(napi::Error::from_reason(format!(
      "dcmdjpeg failed (code: {:?}) for input '{}' and output '{}' using DCMDICTPATH='{}'\nstdout: {}\nstderr: {}",
      output.status.code(),
      input_path.to_string_lossy(),
      output_path.to_string_lossy(),
      dictionary_path.to_string_lossy(),
      stdout,
      stderr
    )));
    }

    Ok(())
}

/// Runs dcm2img to export one input DICOM as a JPEG image.
fn run_dcm2img_jpeg(
    binary_path: &Path,
    dictionary_path: &Path,
    input_path: &Path,
    output_path: &Path,
) -> napi::Result<()> {
    let output = Command::new(binary_path)
        .env("DCMDICTPATH", dictionary_path)
        .arg("+oj")
        .arg(input_path)
        .arg(output_path)
        .output()
        .map_err(|e| {
            napi::Error::from_reason(format!(
                "Failed to execute dcm2img '{}': {}",
                binary_path.to_string_lossy(),
                e
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(napi::Error::from_reason(format!(
      "dcm2img failed (code: {:?}) for input '{}' and output '{}' using DCMDICTPATH='{}'\nstdout: {}\nstderr: {}",
      output.status.code(),
      input_path.to_string_lossy(),
      output_path.to_string_lossy(),
      dictionary_path.to_string_lossy(),
      stdout,
      stderr
    )));
    }

    Ok(())
}

/// Runs ffmpeg to encode sequential JPEG frames into an H.264 MP4 file.
///
/// The pad filter ensures width/height are even so libx264 can encode safely.
fn run_ffmpeg_jpeg_to_mp4(
    ffmpeg_path: &Path,
    input_frames_dir: &Path,
    output_mp4_path: &Path,
) -> napi::Result<()> {
    let input_pattern = input_frames_dir.join("%08d.jpg");

    let output = Command::new(ffmpeg_path)
        .arg("-y")
        .arg("-framerate")
        .arg("10")
        .arg("-i")
        .arg(&input_pattern)
        .arg("-vf")
        .arg("pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2:x=0:y=0:color=black")
        .arg("-c:v")
        .arg("libx264")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg(output_mp4_path)
        .output()
        .map_err(|e| {
            napi::Error::from_reason(format!(
                "Failed to execute ffmpeg '{}': {}",
                ffmpeg_path.to_string_lossy(),
                e
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(napi::Error::from_reason(format!(
            "ffmpeg failed (code: {:?}) for input '{}' and output '{}'
stdout: {}
stderr: {}",
            output.status.code(),
            input_pattern.to_string_lossy(),
            output_mp4_path.to_string_lossy(),
            stdout,
            stderr
        )));
    }

    Ok(())
}

/// Creates a child directory under `parent`, appending numeric suffixes when needed
/// to avoid name collisions.
fn create_unique_subdir(parent: &Path, base_name: &str) -> napi::Result<PathBuf> {
    let trimmed = non_empty_or_default(base_name, "Untitled");

    let mut candidate = parent.join(&trimmed);
    let mut suffix = 1;

    while candidate.exists() {
        candidate = parent.join(format!("{} {}", trimmed, suffix));
        suffix += 1;
    }

    fs::create_dir_all(&candidate).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to create directory '{}': {}",
            candidate.to_string_lossy(),
            e
        ))
    })?;

    Ok(candidate)
}

/// Returns a trimmed string, or the fallback value when input is empty.
fn non_empty_or_default(value: &str, default_value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        default_value.to_string()
    } else {
        trimmed.to_string()
    }
}
