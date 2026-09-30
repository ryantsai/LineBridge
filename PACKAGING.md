# LineBridge installers

| Platform | Package | Build host | Current status |
| --- | --- | --- | --- |
| Windows x64 | NSIS `.exe`, 繁體中文 / English | Windows with MSVC and WebView2 | Built locally; unsigned |
| macOS Apple Silicon | ARM64 `.dmg`, drag to Applications | Native Apple Silicon Mac, macOS 13.5+ | Configuration prepared; Mac build pending |
| macOS Intel | x64 `.dmg`, drag to Applications | Native Intel Mac, macOS 13.5+ | Configuration prepared; Mac build pending |

The app, private LINE worker, Node runtime, cloudflared, licenses and source/checksum manifests are bundled. Packaging excludes the local `data/` directory, LINE credentials, accounts, message database, AI tokens and connector configuration. Both installers use the LineBridge name; the interface defaults to zh-TW.

## Local builds

Install Rust 1.98.1 and Node ≥24. Windows requires Visual Studio C++ build tools. A Mac requires Xcode command-line tools (`xcode-select --install`). Use Rust and Node of the same native architecture; a Rosetta/native mismatch is rejected before building.

```sh
npm ci --ignore-scripts
# On Windows:
npm run desktop:build:windows
# On a Mac (its native ARM64 or x64 architecture):
npm run desktop:build:mac
npm run verify:mac
```

`npm run desktop:build` selects the native platform automatically. DMG creation requires macOS; Windows cannot produce a Tauri DMG. Mac helpers are placed in `Contents/MacOS` as Tauri sidecars and signed with the app. Executable permissions and architecture are checked. The bundle finds its own helpers without requiring Node, cloudflared or Homebrew on the user's PATH.

Outputs are copied into `release/windows-x64/`, `release/macos-arm64/` or `release/macos-x64/`, with `SHA256SUMS.txt` and `build-info.json`. The original Tauri bundles remain in `target/release/bundle/`. On Windows, the source launchers continue to use `target/release/LineBridge.exe` and the existing local data.

The bundled versions and original download hashes are pinned in `packaging/runtimes.json`. Node hashes come from the official [Node.js checksum list](https://nodejs.org/dist/v26.5.0/SHASUMS256.txt); cloudflared hashes come from [Cloudflare's release asset digests](https://github.com/cloudflare/cloudflared/releases/tag/2026.9.3). Changing a version requires updating the verified asset hashes for every platform. Runtime manifests describe bytes before macOS bundle signing, which can change a helper's final binary hash.

## GitHub Actions

`.github/workflows/package.yml` provides **Package LineBridge**, a manual `workflow_dispatch` build. After the project is pushed to a chosen repository, run this workflow from its Actions tab. It builds three native jobs on Windows, Apple Silicon and Intel runners, runs regression checks and uploads the installer/checksum artifacts for 14 days. It does not create or publish a GitHub Release. No GitHub destination has been selected or pushed from this checkout.

The Mac job also verifies signatures and architectures, runs the signed private worker with a nonexistent synthetic account and checks that the native app starts its Rust gateway with an empty temporary database. These checks never log in to LINE or send real messages. Successful CI startup does not establish complete native UI or live LINE compatibility.

## Signing and installation

Windows packages are unsigned. macOS is configured for ad-hoc signing (`-`); no Apple Developer identity or notarization credentials have been supplied. Ad-hoc signing verifies bundle integrity but does not establish an Apple-trusted publisher or notarization. Gatekeeper may require the user to explicitly approve opening an unnotarized app. Follow Apple's normal opening controls; the build does not disable Gatekeeper.

For a later notarized release, provide a Developer ID signing identity and the Tauri-supported Apple signing/notarization secrets in the build environment. The workflow currently builds testing packages and does not configure those secrets. See [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/), [DMG packaging](https://v2.tauri.app/distribute/dmg/) and [Windows NSIS packaging](https://v2.tauri.app/distribute/windows-installer/).

Installers use per-user application data, separate from this checkout. macOS starts with its own account setup and a local 0600 AES key file; Keychain support and Windows-to-Mac credential migration are not implemented. Quit a running LineBridge instance before launching another copy because both use ports 3210/3211.
