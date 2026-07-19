# GitHub Actions デプロイ セットアップ手順（一度だけ行う作業）

このリポジトリは push → 自動デプロイの3系統に分かれています。

| ワークフロー | トリガー | デプロイ先 |
|---|---|---|
| `deploy-workers.yml` | `workers/**` の変更 | KV/R2を自動プロビジョニング → Cloudflare Workers(API Gateway) |
| `deploy-frontend.yml` | `frontend/**` の変更 | Cloudflare Workers(Next.js on OpenNext) |
| `deploy-orchestrator.yml` | `langchain/**` の変更 | GHCRへpush → OCI VM上のself-hosted runnerがpull&再起動 |
| `ci.yml` | Pull Request | 型チェック/ビルドのみ(デプロイなし) |

以下、初回だけ必要な設定です。**手順1は必ず一番最初に行ってください**(これが済んでいないと何をやっても同じエラーで失敗します)。

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
3. 対象アカウントのみにスコープを絞る(全アカウントに広げない)
4. 発行したトークンと、[Account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) を控える

## 3. GitHub Secrets / Variables を設定する

リポジトリの **Settings → Secrets and variables → Actions** で設定します。

**Secrets(暗号化・ログに出ない)**
| 名前 | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 手順2で発行したトークン |
| `CLOUDFLARE_ACCOUNT_ID` | 手順2で控えたAccount ID |

**Variables(平文でよい値)**
| 名前 | 値 |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | 手順4で `deploy-workers.yml` を一度動かした後に得られるWorkerのURL |

> `ORCHESTRATOR_TOKEN` や `WEBHOOK_SECRET` はGitHub Secretsに**登録しません**。Cloudflare Worker側の実行時シークレットなので、手順5で `wrangler secret put` を使ってCloudflare側に直接登録します。

これだけで完了です。KVとR2は `deploy-workers.yml` が `scripts/provision-resources.sh` で自動的に作成します(無ければ作る・あれば再利用、何度実行しても安全)。Terraformや別バケットの用意は不要です。

## 4. API Gateway Workerを初回デプロイする

`workers/` に変更をpushすると `deploy-workers.yml` が自動実行され、以下の順で処理されます。

1. `scripts/provision-resources.sh` がCloudflare REST APIを直接叩き、KV namespace `genstory-oss-book-cache` とR2バケット `genstory-oss-assets` を(無ければ)作成
2. 取得したKV namespace IDを `workers/wrangler.jsonc` の `__KV_NAMESPACE_ID__` に自動注入
3. `wrangler deploy` でWorkerをデプロイ

デプロイ後にWorkerのURLが発行されるので、手順3の `NEXT_PUBLIC_API_BASE_URL` Variableへ反映してください(反映後、`frontend/` へ何かpushすると次回ビルドから使われます)。

## 5. Workerの実行時シークレットを登録する(初回のみ)

```bash
cd workers
npx wrangler secret put ORCHESTRATOR_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

`workers/wrangler.jsonc` の `vars.ORCHESTRATOR_URL` も、OCI VM側のエンドポイント(手順7のCloudflare Tunnelホスト名)に書き換えてください。

## 6. OCI VMにself-hosted runnerを登録する

`deploy-orchestrator.yml` はOCI VM上で直接コンテナを再起動する必要があるため、OCI VM自体をGitHub Actionsのランナーとして登録します(SSHを外部に開けずに済むための設計です)。

1. GitHubリポジトリ → **Settings → Actions → Runners → New self-hosted runner** → OS: Linux, Arch: ARM64(Ampere A1の場合)
2. 画面に表示される手順(`./config.sh --url ... --token ...`)をOCI VM上で実行
3. ラベルを聞かれたら **`oci-vm`** を追加(`deploy-orchestrator.yml` がこのラベルを指定しています)
4. サービス化して常駐させる:
   ```bash
   sudo ./svc.sh install
   sudo ./svc.sh start
   ```

## 7. OCI VM側の環境変数ファイルを用意する

`docker compose` の `.env` はgit管理外かつ、self-hosted runnerのcheckoutディレクトリはワークフロー実行のたびにクリーンされる可能性があるため、**checkoutディレクトリの外**に置きます。

```bash
mkdir -p ~/genstory-secrets
cp ~/actions-runner/_work/genstory-book-ai/genstory-book-ai/infra/.env.example ~/genstory-secrets/orchestrator.env
nano ~/genstory-secrets/orchestrator.env   # 実際の値を入力
chmod 600 ~/genstory-secrets/orchestrator.env
```

`deploy-orchestrator.yml` はこのパス(`~/genstory-secrets/orchestrator.env`)を `--env-file` として参照します。

併せて、OCI VMの外(Cloudflare Workers)からこのVMの `/generate` エンドポイントへ到達できるよう、Cloudflare Tunnelで固定ホスト名を割り当てておくことを推奨します(動的IP対策)。

## 8. 初回起動とモデルの取得

```bash
cd ~/actions-runner/_work/genstory-book-ai/genstory-book-ai/infra
docker compose --env-file ~/genstory-secrets/orchestrator.env --profile core up -d ollama
docker compose --env-file ~/genstory-secrets/orchestrator.env --profile core run --rm ollama-pull
```

以降は `langchain/` にpushするたびに、GitHub Actionsが自動でイメージをビルド・GHCRへpush・OCI VM上で再起動します。

## 動作確認チェックリスト

- [ ] R2が有効化されている(手順1)
- [ ] `workers/` へのpushで `deploy-workers.yml` が成功し、Cloudflareダッシュボード上にKV namespaceとR2バケットが実在する
- [ ] `frontend/` へのpushで `deploy-frontend.yml` が成功する
- [ ] `langchain/` へのpushで `deploy-orchestrator.yml` が成功し、OCI VM上で `docker ps` にorchestratorの新しいコンテナIDが反映される
- [ ] フロントエンドからフォーム送信 → 生成 → ビューア表示までE2Eで通る

## 参考: なぜnpm ciではなくnpm installにしているか

`frontend/` に `package-lock.json` をまだコミットしていないため、`npm ci` は失敗します(`npm ci` はロックファイルの存在が前提)。当面 `npm install` で動かしていますが、ローカルで一度 `npm install` を実行して生成された `package-lock.json` をコミットすれば、`ci.yml` / `deploy-frontend.yml` を `npm ci` に戻してビルドの再現性を上げられます。

## 参考: なぜTerraformをやめたか

当初KV/R2の作成にTerraform + R2バックエンドのstate管理を使う設計にしていましたが、state保存用の別R2バケット・別APIトークン発行・アカウントIDのハードコードなど手動セットアップが多く、エラーの原因になりやすいと判断しました。`scripts/provision-resources.sh` はCloudflare REST APIを直接叩き、無ければ作成・あれば再利用するだけの単純なスクリプトです。差分プレビューはできませんが、KV namespaceとR2バケット2つだけの管理であればこちらの方が壊れにくく、追加の手動セットアップも不要です。
