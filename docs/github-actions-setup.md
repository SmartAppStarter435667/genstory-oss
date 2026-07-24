# GitHub Actions デプロイ セットアップ手順

v2(Cloudflareのみで完結する構成)のため、OCI VMや自宅/クラウドサーバーの準備は一切不要です。以下の手順だけでpushからデプロイまで自動化されます。

| ワークフロー | トリガー | 内容 |
|---|---|---|
| `deploy-workers.yml` | `workers/**` | KV/R2を自動作成 → Cloudflare Workers(API)デプロイ → `/health`確認 |
| `deploy-frontend.yml` | `frontend/**` | Cloudflare Workers(Next.js on OpenNext)デプロイ → `/api/health`確認 |
| `brainstorm-content.yml` | 毎週月曜6:00 JST / 手動 | Workers AIで絵本ネタを複数案生成しコミット + レビューIssue作成 |
| `ci.yml` | Pull Request | 型チェック/ビルドのみ(デプロイなし) |

## 1. Cloudflareダッシュボードで R2 を有効化する【最重要・最初に】

R2をどんな方法で作成しようとしても、アカウント側でR2という機能自体が有効化されていないと `Please enable R2 through the Cloudflare Dashboard. [code: 10042]` のエラーで必ず失敗します。これはAPIやCLIでは回避できない、ダッシュボードでの手動操作が必須の一回限りの手続きです。

1. https://dash.cloudflare.com/ にログイン
2. 左メニューの **R2 Object Storage** を開く
3. 案内に従い有効化する(無料枠内の利用でも支払い情報の登録が求められます)

## 2. Cloudflare API Token を発行する

1. [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens) → **Create Token**
2. **Custom** → Permission に以下3つを追加:
   - **Workers Scripts: Edit**
   - **Workers KV Storage: Edit**
   - **Workers R2 Storage: Edit**
3. 対象アカウントのみにスコープを絞る
4. 発行したトークンと、[Account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) を控える

## 3. Workers AIを有効化する

Workers AIはR2と違い明示的な「有効化」操作は通常不要ですが、アカウントの支払い情報未登録だと呼び出し時にエラーになる場合があります。エラーが出た場合はダッシュボードの **Workers & Pages → AI** で状態を確認してください。

## 4. GitHub Secrets / Variables を設定する

**Settings → Secrets and variables → Actions**

**Secrets**
| 名前 | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 手順2で発行したトークン |
| `CLOUDFLARE_ACCOUNT_ID` | 手順2で控えたAccount ID |

**Variables(任意・通常は設定不要)**
| 名前 | 値 |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | 通常は空でよい。`deploy-frontend.yml`がCloudflare APIからworkers.devサブドメインを自動取得しURLを組み立てるため、手動設定は不要になった。独自ドメインを使う等の理由でURLを固定したい場合のみ、ここに明示的に設定すると自動算出より優先される |

## 5. 初回デプロイ

`workers/`か`frontend/`に何かpushすると、対応するワークフローが自動実行されます。`workers/`側は`scripts/provision-resources.sh`がKV namespace / R2バケットを自動作成するため、事前の手動作成は不要です。`frontend/`側はビルド時にCloudflare APIからAPI GatewayのURLを自動算出するため、手動でのVariable設定は不要です。

> 過去バージョンでは「`deploy-workers.yml`実行後に手動でVariableを設定する」手順でしたが、Next.jsは`NEXT_PUBLIC_*`をビルド時に埋め込むため、Variableを後から設定しても既存のビルドには反映されない問題がありました。自動算出方式に変更してこの問題を解消しています。

## 6. (任意)NVIDIA NIMをストーリー生成に使う

設定しなくてもCloudflare Workers AIだけで動作します。より高品質なテキスト生成を試したい場合のみ:

1. https://build.nvidia.com でアカウント作成(クレジットカード不要) → API Keyを発行
2. ローカルまたはCI経由で登録:
   ```bash
   cd workers
   npx wrangler secret put NVIDIA_NIM_API_KEY
   ```

NIM呼び出しが失敗した場合は自動的にWorkers AIにフォールバックするため、設定ミスがあってもアプリ自体は動作し続けます。

## 7. (任意)ナレーション入り動画エクスポートにGoogle Cloud TTSを使う

未設定でも「動画で見る」モードはブラウザのWeb Speech APIでナレーション付きで再生できます。ただし**ダウンロードした動画ファイルにナレーション音声を含めたい場合**は、実音声ファイルが必要なためGoogle Cloud TTSの設定が必要です(Cloudflare Workers AIのTTSは日本語非対応のため使えません)。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成(未作成の場合)
2. **APIとサービス → ライブラリ** から **Cloud Text-to-Speech API** を有効化
3. **APIとサービス → 認証情報 → 認証情報を作成 → APIキー**
4. 登録:
   ```bash
   cd workers
   npx wrangler secret put GOOGLE_TTS_API_KEY
   ```

無料枠: Standard音声 月400万文字、WaveNet音声 月100万文字(既定は`ja-JP-Wavenet-B`)。生成に失敗しても絵本自体の生成は止まらず、その場合は字幕+効果音のみの動画になります。

## 動作確認チェックリスト

- [ ] R2が有効化されている(手順1)
- [ ] `workers/` へのpushで`deploy-workers.yml`が成功する(`/health`の自動確認込み)
- [ ] `frontend/` へのpushで`deploy-frontend.yml`が成功する(`/api/health`の自動確認込み)
- [ ] フロントエンドからフォーム送信 → 生成 → ビューア表示までE2Eで通る

いずれかのワークフローが失敗した場合、該当ステップのログにエラー内容が出るので貼ってください。
