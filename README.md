# genstory-oss

GenStory相当のAI絵本生成プラットフォームを、OSS（Ollama / LangChain / Milvus Lite / Stable Diffusion系）+ OCI + Cloudflareで構築するプロジェクトです。全体設計は [`docs/architecture.md`](./docs/architecture.md) を参照してください。

## 構成

```
genstory-oss/
├── docs/architecture.md      # 全体アーキテクチャ設計書
├── infra/docker-compose.yml  # OCI VM側の起動定義
├── langchain/                # ストーリー生成(LangChain) + オーケストレーター(FastAPI)
├── workers/                  # API Gateway (Cloudflare Workers / Hono / Durable Objects)
└── frontend/                 # 絵本ビューアUI (Next.js / OpenNext for Cloudflare)
```

## クイックスタート（推奨する順番）

### 1. ストーリー生成を単体で確認する（最初にここから）

```bash
cd langchain
pip install -r requirements.txt --break-system-packages

# 別ターミナルでOllamaを起動しておく
ollama pull llama3.1:8b-instruct-q4_K_M
ollama pull bge-m3

python story_chain.py
```

標準出力に絵本のJSON（title / pages[]）が表示されれば成功です。うまく構造化出力が返らない場合は `story_chain.py` 内のコメントを参照し、`PydanticOutputParser` 方式へ切り替えてください。

### 2. オーケストレーター全体をローカルで起動する

```bash
cd infra
cp .env.example .env   # なければ作成し、下記の環境変数を設定
docker compose --profile core up -d
curl -X POST http://localhost:8000/generate \
  -H "Authorization: Bearer $ORCHESTRATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bookId":"test-1","webhookUrl":"https://webhook.site/xxxx","theme":"...","ageGroup":"3-5","characters":[{"name":"コン"}]}'
```

必要な環境変数: `ORCHESTRATOR_TOKEN` `CF_WEBHOOK_SECRET` `WORKERS_AI_ACCOUNT_ID` `WORKERS_AI_API_TOKEN` `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET_NAME`

### 3. Cloudflare側をデプロイする

```bash
cd workers
npm install hono
npx wrangler kv namespace create BOOK_CACHE
npx wrangler r2 bucket create genstory-oss-assets
npx wrangler secret put ORCHESTRATOR_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy
```

`wrangler.jsonc` 内のKV namespace idと `ORCHESTRATOR_URL` を実際の値に置き換えてください。

### 4. フロントエンドを起動する

```bash
cd frontend
npm install
cp .env.example .env.local   # NEXT_PUBLIC_API_BASE_URL を3.のWorker URLに設定
npm run dev                  # http://localhost:3000

# Cloudflareへデプロイする場合
npm run cf:deploy
```

## 本番デプロイ（GitHub Actions）

`main` へのpushで自動デプロイされます。`.github/workflows/` に3つのワークフローがあります。

| ワークフロー | トリガー | デプロイ先 |
|---|---|---|
| `deploy-workers.yml` | `workers/**` | Cloudflare Workers(API Gateway) |
| `deploy-frontend.yml` | `frontend/**` | Cloudflare Workers(Next.js on OpenNext) |
| `deploy-orchestrator.yml` | `langchain/**` | GHCR → OCI VM(self-hosted runnerが `docker compose pull` して再起動) |

**初回セットアップは自動化できない部分があります**（Cloudflare APIトークンの発行、GitHub Secretsの登録、OCI VMへのself-hosted runner登録など）。[`docs/github-actions-setup.md`](./docs/github-actions-setup.md) の手順を上から順に実行してください。

- 画像生成: 既定はCloudflare Workers AI。高品質化したい場合のみ別GPUマシンで `--profile sd-gpu`
- 詳細な設計判断・運用戦略は [`docs/architecture.md`](./docs/architecture.md) の各章を参照
