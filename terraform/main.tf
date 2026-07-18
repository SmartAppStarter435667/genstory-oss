# terraform/main.tf
#
# KV namespace / R2 bucket をTerraformで宣言的に管理する。
# Workerスクリプト自体は従来どおり wrangler deploy が担当する(範囲を絞って
# 壊れにくくするため。将来的に cloudflare_workers_script でWorker本体まで
# Terraform管理に寄せることも可能)。
#
# 前提: Cloudflareダッシュボードで **R2を有効化済み** であること。
# (R2が無効なままだと、このTerraform自体も同じエラーで失敗します)

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # State を Cloudflare R2 (S3互換API) に保管する。
  # bucket/endpoint は先に手動で作る「ブートストラップ用」バケットで、
  # アプリ本体が使う genstory-oss-assets とは別物。
  # docs/github-actions-setup.md の手順で <CLOUDFLARE_ACCOUNT_ID> を置き換えること。
  backend "s3" {
    bucket = "genstory-tfstate"
    key    = "genstory-oss/terraform.tfstate"
    region = "auto"
    endpoints = {
      s3 = "https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com"
    }
    use_path_style               = true
    skip_credentials_validation  = true
    skip_region_validation       = true
    skip_requesting_account_id   = true
    skip_metadata_api_check      = true
    skip_s3_checksum             = true
  }
}

provider "cloudflare" {
  # CLOUDFLARE_API_TOKEN 環境変数から自動的に読み込まれる(明示指定は不要)
}
