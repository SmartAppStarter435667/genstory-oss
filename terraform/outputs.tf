# terraform/outputs.tf

output "kv_namespace_id" {
  description = "wrangler.jsonc の __KV_NAMESPACE_ID__ に注入するID"
  value       = cloudflare_workers_kv_namespace.book_cache.id
}

output "r2_bucket_name" {
  value = cloudflare_r2_bucket.book_assets.name
}
