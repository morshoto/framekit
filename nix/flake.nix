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
        in pkgs.mkShell {
          packages = with pkgs; [
            bash
            git
            nodejs_22
          ];

          shellHook = ''
            export FRAMEKIT_XCODE_MANIFEST="${./xcode-version.json}"
            echo "Framekit shell: Node $(node --version)"
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
