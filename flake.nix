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

        rustToolchain = pkgs.rust-bin.stable."1.93.0".default;
      in
      {
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
