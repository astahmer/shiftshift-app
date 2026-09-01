{
  description = "shiftshift-tauri dev environment (Rust + Node/pnpm for a Tauri 2 desktop app)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, rust-overlay, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        };
        lib = pkgs.lib;

        rustToolchain = pkgs.rust-bin.stable."1.93.0".default;

        # Same pinned toolchain the devShell uses, wired up as a rustPlatform
        # so `buildRustPackage` below doesn't fall back to nixpkgs' own Rust.
        rustPlatform = pkgs.makeRustPlatform {
          cargo = rustToolchain;
          rustc = rustToolchain;
        };

        # --- Frontend (pnpm) ------------------------------------------------
        #
        # Only the files `tsc && vite build` actually needs — deliberately
        # not `self`/`./.` so gitignored stuff (dist/, node_modules/,
        # src-tauri/target/) never leaks into the Nix store input and the
        # derivation stays reproducible regardless of local build leftovers.
        frontendSrc = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./pnpm-lock.yaml
            ./.npmrc
            ./tsconfig.json
            ./vite.config.ts
            ./index.html
            ./toast.html
            ./src
          ];
        };

        # pnpm from nixpkgs (11.22.0) is only used to populate/read the store
        # hermetically here; it does not need to match package.json's pinned
        # "packageManager" (12.1.0, activated via Corepack in the devShell) —
        # both read the same pnpm-lock.yaml (lockfileVersion 9.0).
        pnpmDeps = pkgs.fetchPnpmDeps {
          pname = "shiftshift-frontend";
          version = "0.1.0";
          src = frontendSrc;
          fetcherVersion = 4;
          hash = "sha256-l57YWgtM0SaJYEhMZMQUa0D0pUXwKGynY1W7N/u2niw=";
        };

        # Builds both `index.html` and `toast.html` entry points (see
        # vite.config.ts's rollupOptions.input) into a plain `dist/` dir.
        frontendDist = pkgs.stdenv.mkDerivation {
          pname = "shiftshift-frontend";
          version = "0.1.0";
          src = frontendSrc;
          inherit pnpmDeps;
          nativeBuildInputs = [ pkgs.nodejs_24 pkgs.pnpm pkgs.pnpmConfigHook ];
          buildPhase = ''
            runHook preBuild
            pnpm run build
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r dist/. $out/
            runHook postInstall
          '';
        };

        # --- Rust / Tauri binary --------------------------------------------
        #
        # `tauri::generate_context!()` (called from src-tauri/src/lib.rs) is a
        # compile-time macro: it embeds tauri.conf.json's `frontendDist`
        # ("../dist", i.e. sibling of src-tauri/) into the binary, so that
        # directory has to physically exist, at that exact relative path,
        # while `cargo build` runs — not just at runtime. That's why we can't
        # just point buildRustPackage at ./src-tauri: we assemble a source
        # tree with src-tauri/ and dist/ (frontendDist above) as siblings,
        # plus .cargo/config.toml one level up from src-tauri so Cargo's
        # upward config search finds it (see that file's own comment for why
        # it pins CC/the linker to /usr/bin/cc).
        rustSrc = pkgs.runCommand "shiftshift-src" { } ''
          mkdir -p $out
          cp -r ${./.cargo} $out/.cargo
          cp -r ${
            lib.fileset.toSource {
              root = ./src-tauri;
              fileset = lib.fileset.unions [
                ./src-tauri/Cargo.toml
                ./src-tauri/Cargo.lock
                ./src-tauri/build.rs
                ./src-tauri/tauri.conf.json
                ./src-tauri/src
                ./src-tauri/icons
                ./src-tauri/capabilities
              ];
            }
          } $out/src-tauri
          cp -r ${frontendDist} $out/dist
        '';

        shiftshift = rustPlatform.buildRustPackage {
          pname = "shiftshift-tauri";
          version = "0.1.0";
          src = rustSrc;
          sourceRoot = "shiftshift-src/src-tauri";

          cargoLock.lockFile = ./src-tauri/Cargo.lock;

          # `rusqlite`'s `bundled-sqlcipher-vendored-openssl` feature compiles
          # SQLCipher and OpenSSL from source at build time (via the
          # vendored `openssl-src`/`libsqlite3-sys` crates), which needs a C
          # compiler (already pinned to /usr/bin/cc by .cargo/config.toml)
          # plus Perl for OpenSSL's `Configure` script.
          nativeBuildInputs = [ pkgs.perl pkgs.pkg-config ];

          # `cargo test` exercises real OS-level surface (CGEventTap/global
          # keyboard hooks, clipboard, tray) that doesn't work — and
          # shouldn't be poked at — inside a sandboxed, non-interactive Nix
          # build. Packaging only needs `cargo build --release`.
          doCheck = false;

          meta = {
            description = "shiftshift: quick-capture desktop utility (Tauri 2)";
            mainProgram = "shiftshift-tauri";
            platforms = lib.platforms.darwin;
          };
        };
      in
      {
        packages = {
          # NOTE: this is the raw `shiftshift-tauri` binary with the frontend
          # assets embedded at compile time (see rustSrc's comment above) —
          # not a signed/notarized `.app` bundle. Producing a bit-perfect
          # bundle would mean reimplementing Tauri's bundler (codesigning,
          # Info.plist generation, DMG/updater artifacts, etc.) in Nix, which
          # is a substantially bigger undertaking than hermetic compilation.
          # For a full `.app`, run `pnpm tauri build` (see README) using the
          # binary/toolchain this derivation proves are reproducible.
          default = shiftshift;

          # Companion CLI (`src-tauri/src/bin/shift.rs`) — built from the
          # same crate/derivation above; this just exposes its binary
          # directly instead of making callers dig through packages.default.
          shift = pkgs.runCommand "shift" { meta.mainProgram = "shift"; } ''
            mkdir -p $out/bin
            ln -s ${shiftshift}/bin/shift $out/bin/shift
          '';
        };

        # Deliberately does not add darwin.apple_sdk frameworks or override
        # CC/the linker here: `.cargo/config.toml` already pins the linker
        # and CC/CXX to /usr/bin/cc (Apple's clang) via absolute paths, which
        # take priority over anything Nix puts on PATH. That's the fix for
        # Nix's clang lacking the macOS SDK's libiconv (see that file's
        # comment) — this shell can freely put Nix's toolchains on PATH
        # without reintroducing the problem.
        devShells.default = pkgs.mkShell {
          packages = [
            rustToolchain
            pkgs.nodejs_24
          ];

          # pnpm itself is not taken from nixpkgs: package.json pins the exact
          # version (12.1.0) via the "packageManager" field, and Corepack
          # (bundled with Node) resolves/activates that exact version. This
          # keeps the pnpm version in one place instead of two.
          shellHook = ''
            export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
            corepack use pnpm@12.1.0 >/dev/null 2>&1 || true
          '';
        };
      });
}
