# Custom Share receiver research

This directory is isolated research, not a production receiver and not evidence that Final Cut sent a callback. Never install a custom destination, launch Final Cut, send it Apple Events, or alter its libraries or existing reservation as part of these tests.

From this worktree after dependency installation:

```sh
node --test scripts/research/custom-share/*.test.mjs
xcrun swiftc scripts/research/custom-share/SwiftReceiver.swift scripts/research/custom-share/swift-tests/main.swift -o /tmp/framekit-share-swift-tests
/tmp/framekit-share-swift-tests
```

The Swift executable constructs `NSAppleEventDescriptor` objects locally and directly invokes the handler; it briefly registers and unregisters its own process handler but sends no Apple Event and does not receive an interprocess event. Its actual Open Document handler unconditionally rejects the event because sender identity, asset correlation, target and output freshness have not been established. The in-memory lock-protected mock separately exercises concurrent duplicates, stale generations, cancellation and loss of state in a fresh instance (not a process-restart test); it has no persistence, target authentication, output verification or cross-process guarantees. It does not model a documented Final Cut callback token or prove behavior of the actual sender.

This is not yet a functional custom Share destination. Apple documents an app bundle with `com.apple.proapps.MediaAssetProtocol` and scripting definitions plus an asset object, `make`, property getters and Open Document handling. A syntax-only bundle and scripting-definition skeleton can be built locally, but it does not implement the asset class, make handler, metadata/data options, scripting access groups, callback correlation, or a destination installation. It must not be installed or launched as a Share destination. Apple's prose and example use different asset-management access-group strings; determine the correct entitlement/access-group behavior for the selected SDK and environment before a separately reviewed test rather than treating either spelling as validated. See the official [packaging instructions](https://developer.apple.com/documentation/professional-video-applications/receiving-media-and-data-through-a-custom-share-destination) and [scripting definition](https://developer.apple.com/documentation/professional-video-applications/creating-scripting-definitions-for-custom-share-destinations).

The Node experiments model strict callback ordering, output hashes and journals. Their generated IDs and event semantics are mock assumptions. Both implementations remain unable to authenticate the native sender or bind the callback to an exact Final Cut target/revision, and the earlier Node race and durability limits remain. No result here clears a reservation or demonstrates native operation completion.

To compile a temporary app without registering or launching it:

```sh
node --test scripts/research/custom-share/package.test.mjs
research_dir=$(mktemp -d -t framekit-share-bundle)
node scripts/research/custom-share/build-bundle.mjs "$research_dir/ShareResearch.app"
```

The build is create-only and limited to the system temporary directory. `plutil` validates the property-list structure; `xmllint` validates the scripting-definition DTD; `sdp` generates a header; and `file` checks the compiled executable. These checks do not validate the behavior, entitlement/access-group spelling, sender authenticity, compatibility, code signing, notarization, or registration with Final Cut. `sdp` itself may return success for erroneous input, so the independently checked DTD is not a substitute for semantic or runtime tests. No app or destination is launched or installed by these commands.
