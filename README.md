# genstory-oss

GenStory相当のAI絵本生成プラットフォームです。**v2: Cloudflareのみで完結する構成**(Workers / Workers AI / R2 / KV / Durable Objects)。ストーリー生成は任意でNVIDIA NIM(build.nvidia.com無料枠)を優先使用できます。サーバー・Docker・SSH・Terraform・Ansibleは一切不要で、`wrangler deploy` だけでデプロイが完了します。

> 旧v1(OCI VM + Ollama + LangChain + Milvus + Docker Compose)は、セットアップの複雑さがボトルネックになったため廃止しました。経緯は`docs/architecture.md`冒頭を参照してください。

## 構成

```
genstory-oss/
├── docs/architecture.md          # 全体アーキテクチャ設計書
├── docs/github-actions-setup.md  # デプロイに必要なSecrets等のセットアップ手順
├── workers/                      # API本体 (Cloudflare Workers / Hono / Durable Objects / Workers AI)
├── frontend/                     # 絵本ビューアUI (Next.js / OpenNext for Cloudflare)
├── scripts/provision-resources.sh  # KV/R2の自動プロビジョニング(冪等)
└── content/story-ideas/          # AIが生成した絵本ネタのストック
```

## クイックスタート

### 1. Cloudflare側をデプロイする

```bash
cd workers
npm install
npx wrangler deploy
```

初回デプロイ時、`scripts/provision-resources.sh`相当の処理はGitHub Actions側で自動実行されます(手動で`wrangler deploy`する場合は、先にKV namespace / R2 bucketの作成が必要です。`docs/github-actions-setup.md`参照)。

実行時シークレットを登録:
```bash
# 任意: ストーリー生成にNVIDIA NIMを優先使用したい場合のみ
npx wrangler secret put NVIDIA_NIM_API_KEY
```

### 2. フロントエンドを起動する

```bash
cd frontend
npm install
cp .env.example .env.local   # NEXT_PUBLIC_API_BASE_URL を1.のWorker URLに設定
npm run dev                  # http://localhost:3000

# Cloudflareへデプロイする場合
npm run cf:deploy
```

## 本番デプロイ（GitHub Actions）

`main` へのpushで自動デプロイされます。

| ワークフロー | トリガー | 内容 |
|---|---|---|
| `deploy-workers.yml` | `workers/**` | KV/R2を自動作成 → Cloudflare Workers(API)デプロイ → `/health`確認 |
| `deploy-frontend.yml` | `frontend/**` | Cloudflare Workers(Next.js on OpenNext)デプロイ → `/api/health`確認 |
| `brainstorm-content.yml` | 毎週月曜6:00 JST / 手動 | AI(Workers AI)が絵本ネタを複数案生成し `content/story-ideas/` へコミット + レビュー用Issueを作成 |
| `ci.yml` | Pull Request | 型チェック/ビルドのみ(デプロイなし) |

初回セットアップの詳細（Cloudflare APIトークン発行、GitHub Secrets登録など）は [`docs/github-actions-setup.md`](./docs/github-actions-setup.md) を参照してください。OCI/Docker/SSHは一切登場しません。

## テキスト生成プロバイダ

- 既定: Cloudflare Workers AI(`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)
- 任意: `NVIDIA_NIM_API_KEY` を設定すると、NVIDIA NIM(`meta/llama-3.3-70b-instruct`等、無料ホスト型API)を優先使用。失敗時/未設定時は自動でWorkers AIにフォールバック

画像生成は既定でCloudflare Workers AI(FLUX)を使用します。詳細な設計判断は [`docs/architecture.md`](./docs/architecture.md) を参照してください。
