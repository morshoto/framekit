# Framekit

[English](./README.md) | 日本語

Framekit は Final Cut Pro 向けのエージェントによる動画編集ランタイムと MCP サーバーです。

## はじめに

利用時は Node.js 20 以上が必要です。リポジトリの開発には Node.js 22.23.5 と pnpm 12.18.0 を使用します。pnpm 12.18.0 は Corepack または任意のパッケージマネージャーでインストールしてください。ネイティブ Workflow Extension の開発には Xcode 16.4 と macOS 15.5 SDK も必要です。

任意の Nix 環境には Node.js、pnpm、FFmpeg/ffprobe、SQLite が含まれます。利用する場合は次を実行します。

```sh
nix develop ./nix
```

リポジトリのルートから依存関係をインストールし、検証を実行します。

```sh
pnpm install --frozen-lockfile
pnpm run hooks:install
pnpm run check:git-config
pnpm run build
pnpm run test
pnpm run check:boundaries
pnpm run check:docs
```

リポジトリのルートから、決定的なインメモリのフィクスチャを使う MCP サーバーを起動できます。通信方式は stdio です。

```sh
pnpm run mcp
```

`FRAMEKIT_EDITOR` はバックエンド、`FRAMEKIT_FCPXML_PATH` は明示的な FCPXML ファイル、`FRAMEKIT_FINAL_CUT_SOCKET` は Workflow Extension のソケットを指定します。ライブ接続の設定は [Getting started](./docs/getting-started.md) を参照してください。

## Codex と Final Cut を接続する

Codex プラグインと Final Cut Workflow Extension は別々にインストールします。ライブ接続が必要な場合、署名済み Extension のアセットが提供されていれば、対応する [GitHub リリース](https://github.com/morshoto/framekit/releases) から入手してください。マーケットプレイスは一度だけ追加します。

```sh
codex plugin marketplace add morshoto/framekit
```

Codex の `/plugins` で **Framekit** をインストールし、新しいセッションを開始します。公開パッケージを利用するため、チェックアウトや手動の `codex mcp add` は不要です。

ヘッドレスモードでは、ローカルメディアの登録、ラフカットの承認、MP4 のレンダリング、編集可能な FCPXML の作成ができます。生成物の検証だけでは、Final Cut への読み込み、再生、編集や書き出しの成功は証明されません。ライブ機能は既存の Workflow Extension ブリッジにのみ接続し、macOS の UI 自動化による Final Cut の起動、アクティブ化、フォーカス、編集は行いません。対応していない操作は利用できません。ネイティブ公開は実験的です。詳細は [Getting started](./docs/getting-started.md) と [Architecture](./docs/architecture.md) を参照してください。

ローカルでネイティブ開発を行う場合は、リポジトリのルートから次を実行します。

```sh
pnpm run xcode:check
bash adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh
pnpm run framekit -- connect finalcut --development
```

## ドキュメントと開発

- [日本語 Docs ソース](./apps/docs/content/docs/ja/introduction.mdx) / [英語 Docs ソース](./apps/docs/content/docs/en/introduction.mdx)（サイトの公開状況は別途管理）
- [ドキュメント一覧](./docs/README.md)、[Getting started](./docs/getting-started.md)、[Architecture](./docs/architecture.md)、[Testing](./docs/testing.md)、[Release](./docs/release.md)
- 開発環境とコントリビューション方法: [CONTRIBUTING.md](./CONTRIBUTING.md)

公開向けの設定、コマンド、機能説明を変更する際は、両言語の README を併せて更新してください。
