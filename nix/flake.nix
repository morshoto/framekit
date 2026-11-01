{
  description = "Framekit development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      manifest = builtins.fromJSON (builtins.readFile ./xcode-version.json);
      forSystem = system:
        let
          pkgs = import nixpkgs { inherit system; };
          pnpmShim = pkgs.writeShellScriptBin "pnpm" ''
            exec ${pkgs.nodejs_22}/bin/corepack pnpm "$@"
          '';
        in pkgs.mkShell {
          packages = with pkgs; [
            bash
            git
            nodejs_22
            pnpmShim
            ffmpeg
            sqlite
          ];

          shellHook = ''
            export FRAMEKIT_XCODE_MANIFEST="${./xcode-version.json}"
            echo "Framekit shell: Node $(node --version)"
            echo "Fixture/headless tools: pnpm from packageManager, FFmpeg/ffprobe, SQLite"
            echo "Native target: Xcode ${manifest.target.xcode.version}, macOS SDK ${manifest.target.macOSSDK}"
            echo "Run: bash nix/check-xcode.sh"
          '';
        };
    in {
      devShells = builtins.listToAttrs (map (system: {
        name = system;
        value = { default = forSystem system; };
      }) systems);
    };
}
