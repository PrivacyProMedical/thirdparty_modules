
# pmtaro-export-plugin
pmtaro-export-plugin is a DICOM export plugin designed to simplify medical image data handling.
It provides an easy way to export DICOM files from your application, making integration with medical imaging workflows more efficient.

## Prerequisites
- Node.js (version 22 or higher)
- Rust (install after Node.js)
  
Make sure both are installed and available in your system’s `PATH`.

### Install Node.js Dependencies
```
npm install -g @napi-rs/cli
npm install --save-dev ava
```

## Installing Tesseract

### Windows
- Install LLVM (Windows x64) from https://github.com/llvm/llvm-project
  - Add the installation path to your system environment variable `PATH`.
- Install Tesseract using vcpkg https://github.com/microsoft/vcpkg:
```
vcpkg install tesseract:x64-windows-static
```

### macOS
Make sure you have Homebrew installed, then run:
```
brew install pkgconf
brew install leptonica
brew install tesseract
```

## Build
```
npm run build
```
This will compile the Rust code and generate Node.js-compatible binaries.
## Test
```
npm run test
```
Runs the test suite using ava.



<br><br>
## Based on napi-rs Template
This repository is a fork of `@napi-rs/package-template` 

> Template project for writing node packages with napi-rs.  
> https://github.com/napi-rs/package-template/

### Usage

1. Click **Use this template**.
2. **Clone** your project.
3. Run `yarn install` to install dependencies.
4. Run `yarn napi rename -n [@your-scope/package-name] -b [binary-name]` command under the project folder to rename your package.