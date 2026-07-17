# GitHub Actions デプロイ セットアップ手順（一度だけ行う作業）

このリポジトリは push → 自動デプロイの3系統に分かれています。

| ワークフロー | トリガー | デプロイ先 |
|---|---|---|
| `deploy-workers.yml` | `workers/**` の変更 | Cloudflare Workers(API Gateway) |
| `deploy-frontend.yml` | `frontend/**` の変更 | Cloudflare Workers(Next.js on OpenNext) |
| `deploy-orchestrator.yml` | `langchain/**` の変更 | GHCRへpush → OCI VM上のself-hosted runnerがpull&再起動 |
| `ci.yml` | Pull Request | 型チェック/ビルドのみ(デプロイなし) |

以下、初回だけ必要な設定です。CIが動くだけでは終わらないので、順番に進めてください。

## 1. Cloudflare API Token を発行する

1. [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens) → **Create Token**
2. **Custom** → Permission に **Edit Cloudflare Workers** を選択
3. 対象アカウントのみにスコープを絞る(全アカウントに広げない)
4. 発行したトークンと、[Account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) を控える

## 2. GitHub Secrets / Variables を設定する

リポジトリの **Settings → Secrets and variables → Actions** で設定します。

**Secrets(暗号化・ログに出ない)**
| 名前 | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 手順1で発行したトークン |
| `CLOUDFLARE_ACCOUNT_ID` | 手順1で控えたAccount ID |

**Variables(平文でよい値)**
| 名前 | 値 |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | 手順3で `deploy-workers.yml` を一度動かした後に得られるWorkerのURL(例: `https://genstory-oss-api-gateway.<subdomain>.workers.dev`) |

> `ORCHESTRATOR_TOKEN` や `WEBHOOK_SECRET` はGitHub Secretsに**登録しません**。これらはCloudflare Worker側の実行時シークレットなので、手順4で `wrangler secret put` を使ってCloudflare側に直接登録します。

## 3. API Gateway Workerを初回デプロイする

`workers/` に変更をpushすると `deploy-workers.yml` が自動実行されます。初回はKV/R2の実リソースがまだ無いため、先にローカルから一度だけ作成してください。

```bash
cd workers
npx wrangler kv namespace create BOOK_CACHE
npx wrangler r2 bucket create genstory-oss-assets
```

出力された `id` を `workers/wrangler.jsonc` の `kv_namespaces[0].id` に反映し、コミット・pushしてください。push後、`deploy-workers.yml` が自動でデプロイします。

デプロイ後にWorkerのURLが発行されるので、手順2の `NEXT_PUBLIC_API_BASE_URL` Variableへ反映してください(反映後、`frontend/` へ何かpushすると次回ビルドから使われます)。

## 4. Workerの実行時シークレットを登録する(初回のみ)

```bash
cd workers
npx wrangler secret put ORCHESTRATOR_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

`workers/wrangler.jsonc` の `vars.ORCHESTRATOR_URL` も、OCI VM側のエンドポイント(手順6のCloudflare Tunnelホスト名)に書き換えてください。

## 5. OCI VMにself-hosted runnerを登録する

`deploy-orchestrator.yml` はOCI VM上で直接コンテナを再起動する必要があるため、OCI VM自体をGitHub Actionsのランナーとして登録します(SSHを外部に開けずに済むための設計です)。

1. GitHubリポジトリ → **Settings → Actions → Runners → New self-hosted runner** → OS: Linux, Arch: ARM64(Ampere A1の場合)
2. 画面に表示される手順(`./config.sh --url ... --token ...`)をOCI VM上で実行
3. ラベルを聞かれたら **`oci-vm`** を追加(`deploy-orchestrator.yml` がこのラベルを指定しています)
4. サービス化して常駐させる:
   ```bash
   sudo ./svc.sh install
   sudo ./svc.sh start
   ```

## 6. OCI VM側の環境変数ファイルを用意する

`docker compose` の `.env` はgit管理外かつ、self-hosted runnerのcheckoutディレクトリはワークフロー実行のたびにクリーンされる可能性があるため、**checkoutディレクトリの外**に置きます。

```bash
mkdir -p ~/genstory-secrets
cp ~/actions-runner/_work/genstory-book-ai/genstory-book-ai/infra/.env.example ~/genstory-secrets/orchestrator.env
nano ~/genstory-secrets/orchestrator.env   # 実際の値を入力
chmod 600 ~/genstory-secrets/orchestrator.env
```

`deploy-orchestrator.yml` はこのパス(`~/genstory-secrets/orchestrator.env`)を `--env-file` として参照します。

併せて、OCI VMの外(Cloudflare Workers)からこのVMの `/generate` エンドポイントへ到達できるよう、Cloudflare Tunnelで固定ホスト名を割り当てておくことを推奨します(動的IP対策)。

## 7. 初回起動とモデルの取得

```bash
cd ~/actions-runner/_work/genstory-book-ai/genstory-book-ai/infra
docker compose --env-file ~/genstory-secrets/orchestrator.env --profile core up -d ollama
docker compose --env-file ~/genstory-secrets/orchestrator.env --profile core run --rm ollama-pull
```

以降は `langchain/` にpushするたびに、GitHub Actionsが自動でイメージをビルド・GHCRへpush・OCI VM上で再起動します。

## 動作確認チェックリスト

- [ ] `workers/` へのpushで `deploy-workers.yml` が成功する
- [ ] `frontend/` へのpushで `deploy-frontend.yml` が成功する
- [ ] `langchain/` へのpushで `deploy-orchestrator.yml` が成功し、OCI VM上で `docker ps` にorchestratorの新しいコンテナIDが反映される
- [ ] フロントエンドからフォーム送信 → 生成 → ビューア表示までE2Eで通る
