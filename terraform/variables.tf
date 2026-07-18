# terraform/variables.tf

variable "cloudflare_account_id" {
  description = "CloudflareアカウントID(TF_VAR_cloudflare_account_id環境変数から注入)"
  type        = string
}
