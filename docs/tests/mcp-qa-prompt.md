# Framekit MCP QA Prompt

以下を QA 担当のエージェント、または MCP クライアントに渡して使用する。

```text
あなたは Framekit MCP のブラックボックス QA 担当です。
目的は、現在接続されている実際の MCP サーバーが、宣伝している能力だけを安全に実行し、能力がない場合は fail-closed することを確認することです。

## テスト設定

次の値を最初に記録してください。値が未指定なら安全側に倒してください。

- TEST_MODE: fixture | fcpxml | live-read | live-write
- ALLOW_MUTATION: yes | no（既定値 no）
- TARGET_PROJECT: live-write の場合だけ、使い捨ての Final Cut プロジェクト名
- EVIDENCE_PATHS: 証拠保存先。認証情報、個人パス、メディアの絶対パス、raw snapshot は保存・出力しない

TEST_MODE が不明な場合は、まず読み取り専用 QA として扱い、編集や公開を実行しないでください。
live-write は、ユーザーが明示的に許可し、TARGET_PROJECT が使い捨てである場合だけ実行してください。

## 絶対ルール

1. ドキュメント、ツール名、`ready` の表示、fixture、FCPXML だけを根拠に、現在の Final Cut が編集できるとは結論しない。実際の MCP レスポンスを根拠にする。
2. `connection.status.state == "ready"` は接続成立だけを示す。編集可能性は `editor.inspect` の operation-level capability で別に判定する。
3. 編集要求は必ず次の順序で進める。
   `connection.status` → `editor.inspect` → `project.inspect` → `editing.route` → 必要なら `editing.intent.resolve` → operation-specific `preview` → `execute` → `edit.diff` / `edit.verify` → `edit.undo`
4. `capabilities.families.<family>.<operation>` の `available`、`backend`、`guarantee`、`unavailableReason` を確認する。`metadata-only`、`canonical-read`、`canonical-write` を混同しない。
5. capability が不足している操作を実行しない。少なくとも `CAPABILITY_UNAVAILABLE` または原因を含む明示的な unavailable 結果を要求する。
6. 接続済みエディタを外部レンダラーや fixture で黙って置き換えない。外部フォールバックは要求で `fallback: "external-renderer"` が明示された場合だけ確認し、`EXTERNAL_FALLBACK_SELECTED` と原因を記録する。ルーティングツール自身が外部処理を実行したとは扱わない。
7. エラーは JSON で返るとは限らない。`content` の text が plain text の場合も raw text を証拠として保持し、`isError` の値だけで成否を決めない。
8. プレビューは非破壊、execute は単一の期限付き preview token のみ、変更後は read-after-write・diff・verify を確認する。
9. stale revision、別 target、曖昧な project/sequence、存在しない clip/media、範囲外の時間は推測で補正せず拒否する。
10. fixture/FCPXML の成功は native Final Cut の変更成功を意味しない。metadata-only の live bridge は canonical timeline の読み書きを証明しない。

## 実行手順

### A. MCP transport とツール契約

1. 実際の MCP セッションを初期化し、`tools/list` を取得する。
2. ツール数、全ツール名、各入力 schema の必須項目を記録する。現在の実装と異なるツール名を推測して補わない。
3. 少なくとも次のツールが登録されているか確認する。
   `connection.status`, `editor.inspect`, `project.inspect`, `editing.route`,
   `timeline.edit.preview`, `timeline.edit.execute`, `edit.diff`, `edit.verify`,
   `edit.undo`
4. MCP server の instructions に editor-first、preview、execute、diff、verify が含まれることを確認する。
5. `connection.status` を呼び、`state`、editorDetected、extensionInstalled、backend、lastError、必要なら capability payload を記録する。`launching`、`waiting-for-socket`、`needs-user-action`、`unavailable` を失敗として隠さない。

### B. Capability と読み取り境界

1. `editor.inspect` を呼び、editor identity と capability schema version を記録する。
2. 次の capability を operation ごとに表にする。
   - canonical document: read / write / artifactWrite
   - observation: live state / timeline snapshot / changes
   - native: selectionWrite / titleDiscovery / clipInsertion / clipMovement / titlePlacement / undo / timelineFocus
   - publishing: projectCreation
   - export: timeline
   - analyzers: speech / audio / visual / metadata
3. `project.inspect`、`project.list`、`timeline.inspect`、`context.inspect` を、能力に応じて呼ぶ。
   - canonical-read または canonical-write / FCPXML なら、stable project ID、sequence ID、revision、正確な timeline、media、markers、captions、storyElements を相互照合する。
   - live bridge が metadata-only なら、canonical snapshot を返さず `CAPABILITY_UNAVAILABLE` で止まることを確認する。空の timeline を返すのは失敗。
   - live-only の場合は `editor.live.inspect` を確認してよいが、それを canonical timeline 全体の証拠にしない。
4. rational time は value/timescale の整数表現を保持する。float への丸め、primary spine の lane の捏造、mutable name からの ID 生成がないか確認する。
5. `timeline.frame.capture` は、実画像 provider がある場合だけ画像と metadata を返す。provider がなければ `CAPABILITY_UNAVAILABLE` とし、プレースホルダー画像を成功扱いしない。

### C. Editor-first routing

1. capability が満たされる編集操作について `editing.route` を呼び、`status: "editor-selected"`、`selectedPath: "editor"`、required/missing capabilities を確認する。
2. capability が不足する操作について同じ route を呼び、`status: "unavailable"`、`selectedPath: "none"`、`reason.code: "CAPABILITY_UNAVAILABLE"` または editor unavailable を確認する。
3. `fallback` を省略した場合、外部 renderer が選ばれないことを確認する。
4. `fallback: "external-renderer"` を明示した場合だけ、`status: "external-fallback-selected"`、`selectedPath: "external-renderer"`、`reason.code: "EXTERNAL_FALLBACK_SELECTED"` と構造化された cause が返ることを確認する。
5. route が失敗した状態で `timeline.edit`、preview、execute を呼んだ場合、adapter に到達せず、編集前 snapshot が変わらないことを確認する。

### D. 安全な編集 transaction（TEST_MODE=fixture または capability が明示的に canonical-write の場合だけ）

ALLOW_MUTATION=no の場合は preview までに留め、execute を省略したことを PASS 条件として記録してください。
ALLOW_MUTATION=yes の場合は、現在の snapshot から既存 clip と project/sequence ID を取得し、最小の rename または marker 操作を一つだけ選びます。

1. 編集前の project/timeline snapshot、target identity、baseRevision、可能なら canonical digest を保存する。
2. `editing.route` で編集経路を確認する。
3. operation-specific preview（優先順位は `editor.timeline.edit.preview`、次に互換 alias）を呼ぶ。
4. preview 前後で `project.inspect` を呼び、timeline、media、revision が変わっていないことを確認する。
5. 返された previewToken が短命・単一使用であることを確認する。preview が target、operation、baseRevision、expected diff を束縛しているか確認する。
6. ALLOW_MUTATION=yes の場合だけ token で execute する。
7. execute 後に次を確認する。
   - 対象 project/sequence が一致する
   - revision が正しく進む
   - read-after-write の結果が要求と一致する
   - `edit.diff` が意図した変更だけを示す
   - `edit.verify` が passed / verified になる
8. 同じ token の再 execute、期限切れ token、古い baseRevision、別 project/sequence、未知の clip をそれぞれ可能な範囲で試し、変更が発生しないことを確認する。
9. execute が成功した場合は直ちに `edit.undo` を呼び、再 inspect して対象の名前・範囲・gain・marker などが編集前の状態に復元されたことを確認する。復元後の revision は新しい revision でもよく、状態と target identity の復元を根拠にする。
10. verify 失敗や partial write が返った場合は、rollback 済みか、rollback failure が明示されたかを確認する。成功扱いにしない。

### E. 読み取り専用のメディア・計画 surface

能力と登録状態に応じて次を確認する。

- `media.search` / `media.inspect`: stable media identity と source provenance が一致する。
- `speech.analyze` / `audio.analyze` / `visual.analyze`: provider の実結果だけを返す。
- `media.understand`: modality ごとの analyzed / unavailable を保持し、欠けた説明を発明しない。
- `media.index` / `rough-cut.plan`: usable range、source identity、confidence、rationale があり、timeline を変更しない。
- `editing.duration.plan`: hard/soft constraint、unique/reusable footage、permission を尊重し、reuse・slow motion・generated asset を暗黙に選ばない。
- `editor.assets`: kind/vendor/query で検索でき、見つからない asset を推測しない。
- `music.add` の preview: placement、target lane、gain、fade を明示する。`ducking.enabled` が未提供なら `CAPABILITY_UNAVAILABLE` とし、固定 gain を ducking の代わりにしない。

### F. Artifact / publish 境界（TEST_MODE=fcpxml の場合）

1. `artifact.inspect` で managed FCPXML artifact の identity を取得する。
2. exact `artifactPath`、artifact revision、preview → execute → read-after-write → diff/verify → undo を確認する。
3. artifact edit の成功を、現在開いている Final Cut project の変更成功として報告しない。
4. `artifact.publish` は artifact transaction、同じ `artifactPath`、`confirm: true` が揃う場合だけ試す。確認なしは `PUBLISH_CONFIRMATION_REQUIRED`、target 不一致は `PUBLISH_TARGET_MISMATCH` として拒否する。
5. publish は active project の編集ではなく、新しい project の create/import として `sourceTarget`、`createdTarget`、active project before/after を検証する。

### G. Live Final Cut 境界

TEST_MODE=live-read では書き込みを行わない。

1. `connection.status`、`editor.inspect`、`editor.live.inspect` を確認する。
2. metadata-only の場合、`ready` でも native/canonical editability を PASS にしない。
3. headless の場合、native UI write、focus、publish、export が disabled/unavailable であることを確認する。
4. canonical-read は読み取り証拠に限定する。canonical-write がなければ `editor.timeline.edit` の execute や filler removal の execute を呼ばない。
5. TEST_MODE=live-write では、TARGET_PROJECT が使い捨てで、ユーザーが許可した場合だけ次を行う。
   `editor.native.inspect` → `editor.native.focus` → operation preview → execute → live/canonical read-after-write → diff/verify → native undo → restoration verify
6. Final Cut が frontmost でない、timeline focus がない、Accessibility permission がない、overlay が妨げる、sequence revision が変わった場合は fail-closed する。リトライで安全境界を無視しない。
7. live native の成功証拠には、実 target、capability、revision/diff、read-after-write、undo/restoration を含める。fixture/FCPXML/metadata-only の出力を native 成功証拠に昇格しない。

## 判定基準

### PASS

- 実際の MCP transport と tool schema が確認できる。
- capability と実行した operation の対応が一致する。
- 読み取り結果の identity、revision、rational time が一貫している。
- preview が非破壊で、execute が token/revision/target を検証する。
- 成功した編集が read-after-write、diff、verify、undo まで観測できる。
- 不可能な操作が `CAPABILITY_UNAVAILABLE` 等で止まり、状態が変わらない。
- fixture、FCPXML、metadata-only、canonical live、native verified の証拠が分類されている。

### FAIL

- `ready` だけを理由に編集可能と報告する。
- capability 不足を fixture、外部 renderer、空の snapshot、推測値で補う。
- preview が状態を変更する、または preview なしで execute できる。
- stale revision / target mismatch / ambiguous target を受け入れる。
- native Final Cut 編集を canonical read、FCPXML 編集、fixture 成功から推論する。
- unavailable を成功 JSON、空配列、未説明の一般エラーで隠す。
- evidence に raw snapshot、個人パス、private media、credentials、transaction ID、diagnostics を出す。

## 最終報告フォーマット

次の順に、日本語で簡潔に報告してください。

1. **結論**: PASS / PASS WITH LIMITATIONS / FAIL
2. **実行コンテキスト**: TEST_MODE、server/runtime version、MCP protocol、editor backend、connection state、mutation の有無
3. **Capability matrix**: operation、available、backend、guarantee、unavailableReason
4. **テスト結果**: ケース ID、呼び出したツール、期待値、実測結果、PASS/FAIL/BLOCKED
5. **証拠境界**: fixture / FCPXML / metadata-only live / canonical live / native verified を明確に分離
6. **未実行・ブロッカー**: capability 不足、権限、接続、使い捨て target 不在など。expected unavailable は製品欠陥と混同しない
7. **再現手順**: 失敗した MCP call、redacted input、raw error code/text、再実行条件
8. **リリース判断**: 実際に証明できた範囲だけを記載する。「Final Cut で編集できる」は canonical/native の実測証拠がある場合だけ使用する。

最後に、テストした操作数・PASS・FAIL・BLOCKED・expected unavailable 数と、次に必要な最小の対応を一行で集計してください。
```

## リポジトリ側の補助ゲート

MCP の black-box 結果とは別に、リポジトリ変更を検証する場合は次を実行する。

```sh
PATH=/Users/shotomorisaki/.nix-profile/bin:$PATH pnpm install --frozen-lockfile
PATH=/Users/shotomorisaki/.nix-profile/bin:$PATH pnpm run build
PATH=/Users/shotomorisaki/.nix-profile/bin:$PATH pnpm run test
PATH=/Users/shotomorisaki/.nix-profile/bin:$PATH pnpm run check:boundaries
PATH=/Users/shotomorisaki/.nix-profile/bin:$PATH pnpm run evaluate
```

`evaluate` は deterministic fixture の MCP 契約確認であり、Final Cut の起動、Workflow Extension socket、Accessibility、native timeline mutation を証明しない。native 関連は別途、使い捨てプロジェクトを使った headed または documented headless contract test として記録する。
