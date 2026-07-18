# terraform/r2.tf
#
# 絵本の挿絵・アセットを保存するR2バケット。
# wrangler.jsonc の r2_buckets binding は bucket_name(名前)で参照するため、
# こちらはKVと違いID注入は不要 — 名前さえ一致していればそのまま動く。

resource "cloudflare_r2_bucket" "book_assets" {
  account_id = var.cloudflare_account_id
  name       = "genstory-oss-assets"
  location   = "apac" # ユーザー/OCI VMに近いリージョン。必要に応じて変更可
}
