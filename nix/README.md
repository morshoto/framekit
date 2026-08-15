# Reproducible development environment

Enter the project shell with:

```sh
nix develop ./nix
```

The flake provides Node.js 22, Git, and Bash. Xcode is intentionally not
packaged by Nix: Apple's Workflow Extension SDK and `ProExtensionHost` must be
provided by a real Xcode installation selected with `xcode-select`.

The native compatibility target is recorded in
[`xcode-version.json`](./xcode-version.json). Run the check before building the
Workflow Extension:

```sh
bash nix/check-xcode.sh
```

The manifest currently targets Xcode 16.4 / macOS SDK 15.5 and records the
machine's observed Command Line Tools state separately. Update the manifest in
the same change as any Xcode or SDK compatibility decision.
