# terraform/kv.tf
#
# API Gateway Worker(workers/wrangler.jsonc の BOOK_CACHE binding)が使うKV namespace。
# 生成されたIDは deploy-workers.yml が `terraform output` で取得し、
# wrangler.jsonc の __KV_NAMESPACE_ID__ プレースホルダへ注入する。

resource "cloudflare_workers_kv_namespace" "book_cache" {
  account_id = var.cloudflare_account_id
  title      = "genstory-oss-book-cache"
}
