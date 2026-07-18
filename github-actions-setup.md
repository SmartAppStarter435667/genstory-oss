# GitHub Actions デプロイ セットアップ手順（一度だけ行う作業）

このリポジトリは push → 自動デプロイの3系統に分かれています。

| ワークフロー | トリガー | デプロイ先 |
|---|---|---|
| `deploy-workers.yml` | `workers/**` `terraform/**` の変更 | Terraform apply(KV/R2作成) → Cloudflare Workers(API Gateway) |
| `deploy-frontend.yml` | `frontend/**` の変更 | Cloudflare Workers(Next.js on OpenNext) |
| `deploy-orchestrator.yml` | `langchain/**` の変更 | GHCRへpush → OCI VM上のself-hosted runnerがpull&再起動 |
| `ci.yml` | Pull Request | 型チェック/ビルドのみ(デプロイなし) |

以下、初回だけ必要な設定です。**手順1は必ず一番最初に行ってください**(これが済んでいないと、Terraformもwranglerも同じエラーで失敗します)。

## 1. Cloudflareダッシュボードで R2 を有効化する【最重要・最初に】

KV/R2をTerraformで自動作成しようとしても、アカウント側でR2という機能自体が有効化されていないと `Please enable R2 through the Cloudflare Dashboard. [code: 10042]` のエラーで必ず失敗します。これはAPIやCLIやTerraformでは回避できない、ダッシュボードでの手動操作が必須の一回限りの手続きです。

1. https://dash.cloudflare.com/ にログイン
2. 左メニューの **R2 Object Storage** を開く
3. 案内に従い有効化する(無料枠内の利用でも支払い情報の登録が求められます)

## 2. Cloudflare API Token を発行する

1. [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens) → **Create Token**
2. **Custom** → Permission に **Edit Cloudflare Workers**、**Workers R2 Storage: Edit**、**Workers KV Storage: Edit** を追加
3. 対象アカウントのみにスコープを絞る(全アカウントに広げない)
4. 発行したトークンと、[Account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) を控える

## 3. GitHub Secrets / Variables を設定する

リポジトリの **Settings → Secrets and variables → Actions** で設定します。

**Secrets(暗号化・ログに出ない)**
| 名前 | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 手順2で発行したトークン |
| `CLOUDFLARE_ACCOUNT_ID` | 手順2で控えたAccount ID |
| `TF_STATE_R2_ACCESS_KEY_ID` | 手順4で発行するR2 APIトークンのAccess Key ID |
| `TF_STATE_R2_SECRET_ACCESS_KEY` | 手順4で発行するR2 APIトークンのSecret Access Key |

**Variables(平文でよい値)**
| 名前 | 値 |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | 手順6で `deploy-workers.yml` を一度動かした後に得られるWorkerのURL |

> `ORCHESTRATOR_TOKEN` や `WEBHOOK_SECRET` はGitHub Secretsに**登録しません**。Cloudflare Worker側の実行時シークレットなので、手順7で `wrangler secret put` を使ってCloudflare側に直接登録します。
>
> `TF_STATE_R2_ACCESS_KEY_ID` / `TF_STATE_R2_SECRET_ACCESS_KEY` は、オーケストレーターが使う `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`(infra/.env、アプリのデータ用)とは**別物**です。Terraformの状態(state)保存専用のトークンなので混同しないよう注意してください。

## 4. Terraform State用のR2バケットとAPIトークンを用意する(ブートストラップ)

Terraformが「KV/R2を自動作成する」ためには、Terraform自身の状態(state)をどこかに保存する必要があります。これだけは卵が先か鶏が先かの問題でTerraformでは自動化できないため、手動で1個だけバケットを作ります。

```bash
cd workers
npx wrangler r2 bucket create genstory-tfstate
```

続けてCloudflareダッシュボード → R2 → **Manage R2 API Tokens** → **Create API Token** で、`genstory-tfstate` バケットに対する **Object Read & Write** 権限のトークンを発行し、表示される Access Key ID / Secret Access Key を手順3のGitHub Secretsへ登録してください。

## 5. terraform/main.tf のアカウントIDを置き換える

Terraformのbackend設定はTerraformの仕様上、変数や環境変数を使えず値を直接書く必要があります。`terraform/main.tf` を開き、以下を実際のCloudflareアカウントIDに置き換えてコミットしてください(Account IDは秘密情報ではないため、コミットして問題ありません)。

```diff
- s3 = "https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com"
+ s3 = "https://実際のアカウントID.r2.cloudflarestorage.com"
```

## 6. API Gateway Workerを初回デプロイする

`workers/` か `terraform/` に変更をpushすると `deploy-workers.yml` が自動実行されます。ワークフローの中で

1. `terraform apply` がKV namespaceと `genstory-oss-assets` R2バケットを作成(既に存在すれば何もしない、冪等)
2. 生成されたKV namespace IDを `workers/wrangler.jsonc` の `__KV_NAMESPACE_ID__` に自動注入
3. `wrangler deploy` でWorkerをデプロイ

という順で実行されるため、手動での `wrangler kv namespace create` は不要です。

デプロイ後にWorkerのURLが発行されるので、手順3の `NEXT_PUBLIC_API_BASE_URL` Variableへ反映してください(反映後、`frontend/` へ何かpushすると次回ビルドから使われます)。

## 7. Workerの実行時シークレットを登録する(初回のみ)

```bash
cd workers
npx wrangler secret put ORCHESTRATOR_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

`workers/wrangler.jsonc` の `vars.ORCHESTRATOR_URL` も、OCI VM側のエンドポイント(手順9のCloudflare Tunnelホスト名)に書き換えてください。

## 8. OCI VMにself-hosted runnerを登録する

`deploy-orchestrator.yml` はOCI VM上で直接コンテナを再起動する必要があるため、OCI VM自体をGitHub Actionsのランナーとして登録します(SSHを外部に開けずに済むための設計です)。

1. GitHubリポジトリ → **Settings → Actions → Runners → New self-hosted runner** → OS: Linux, Arch: ARM64(Ampere A1の場合)
2. 画面に表示される手順(`./config.sh --url ... --token ...`)をOCI VM上で実行
3. ラベルを聞かれたら **`oci-vm`** を追加(`deploy-orchestrator.yml` がこのラベルを指定しています)
4. サービス化して常駐させる:
   ```bash
   sudo ./svc.sh install
   sudo ./svc.sh start
   ```

## 9. OCI VM側の環境変数ファイルを用意する

`docker compose` の `.env` はgit管理外かつ、self-hosted runnerのcheckoutディレクトリはワークフロー実行のたびにクリーンされる可能性があるため、**checkoutディレクトリの外**に置きます。

```bash
mkdir -p ~/genstory-secrets
cp ~/actions-runner/_work/genstory-book-ai/genstory-book-ai/infra/.env.example ~/genstory-secrets/orchestrator.env
nano ~/genstory-secrets/orchestrator.env   # 実際の値を入力(R2_ACCESS_KEY_ID等はアプリ用の別トークン)
chmod 600 ~/genstory-secrets/orchestrator.env
```

`deploy-orchestrator.yml` はこのパス(`~/genstory-secrets/orchestrator.env`)を `--env-file` として参照します。

併せて、OCI VMの外(Cloudflare Workers)からこのVMの `/generate` エンドポイントへ到達できるよう、Cloudflare Tunnelで固定ホスト名を割り当てておくことを推奨します(動的IP対策)。

## 10. 初回起動とモデルの取得

```bash
cd ~/actions-runner/_work/genstory-book-ai/genstory-book-ai/infra
docker compose --env-file ~/genstory-secrets/orchestrator.env --profile core up -d ollama
docker compose --env-file ~/genstory-secrets/orchestrator.env --profile core run --rm ollama-pull
```

以降は `langchain/` にpushするたびに、GitHub Actionsが自動でイメージをビルド・GHCRへpush・OCI VM上で再起動します。

## 動作確認チェックリスト

- [ ] R2が有効化されている(手順1)
- [ ] `terraform/` か `workers/` へのpushで `deploy-workers.yml` が成功し、Cloudflareダッシュボード上にKV namespaceとR2バケットが実在する
- [ ] `frontend/` へのpushで `deploy-frontend.yml` が成功する
- [ ] `langchain/` へのpushで `deploy-orchestrator.yml` が成功し、OCI VM上で `docker ps` にorchestratorの新しいコンテナIDが反映される
- [ ] フロントエンドからフォーム送信 → 生成 → ビューア表示までE2Eで通る

## 参考: なぜnpm ciではなくnpm installにしているか

`frontend/` に `package-lock.json` をまだコミットしていないため、`npm ci` は失敗します(`npm ci` はロックファイルの存在が前提)。当面 `npm install` で動かしていますが、ローカルで一度 `npm install` を実行して生成された `package-lock.json` をコミットすれば、`ci.yml` / `deploy-frontend.yml` を `npm ci` に戻してビルドの再現性を上げられます。
