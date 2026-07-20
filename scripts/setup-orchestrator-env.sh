#!/usr/bin/env bash
# scripts/setup-orchestrator-env.sh
#
# ~/genstory-secrets/orchestrator.env を作成する。docs/github-actions-setup.md
# 手順7 の自動化版。実際の値(CloudflareのAPIトークン等)はこのスクリプトからは
# 分からないため対話的に入力するが、ディレクトリ作成・正しいキー名での書き込み・
# chmod 600・入力漏れチェックまでを自動化し、手作業でのtypoや権限ミスを防ぐ。
#
# 実行方法(OCI VM上で): ./scripts/setup-orchestrator-env.sh
#
# 特定の値だけ非対話で設定したい場合は、先にexportしておけばプロンプトされず
# その値がそのまま使われる。例:
#   export R2_BUCKET_NAME=genstory-oss-assets
#   ./scripts/setup-orchestrator-env.sh

set -euo pipefail

SECRETS_DIR="${SECRETS_DIR:-$HOME/genstory-secrets}"
ENV_FILE="${SECRETS_DIR}/orchestrator.env"
mkdir -p "$SECRETS_DIR"

prompt_value() {
  # prompt_value VAR_NAME "説明" ["既定値"] [--secret]
  local var_name="$1" description="$2" default_value="${3:-}" secret_flag="${4:-}"
  local existing_value input

  # 既にexport済みならプロンプトせずそれを採用(非対話実行・自動化向け)
  existing_value=$(printenv "$var_name" 2>/dev/null || true)
  if [ -n "$existing_value" ]; then
    echo "$existing_value"
    return
  fi

  if [ "$secret_flag" = "--secret" ]; then
    read -r -s -p "${var_name} — ${description}: " input >&2
    echo >&2
  elif [ -n "$default_value" ]; then
    read -r -p "${var_name} — ${description} [既定: ${default_value}]: " input >&2
  else
    read -r -p "${var_name} — ${description}(任意、空欄可): " input >&2
  fi

  echo "${input:-$default_value}"
}

random_secret() {
  openssl rand -hex 24 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 48
}

echo "== ${ENV_FILE} を作成します =="
echo "(値を先にexportしておくと、その項目はプロンプトされずそのまま使われます)"
echo ""

ORCHESTRATOR_TOKEN=$(prompt_value ORCHESTRATOR_TOKEN "CloudflareWorkerとの共有トークン" "$(random_secret)" --secret)
CF_WEBHOOK_SECRET=$(prompt_value CF_WEBHOOK_SECRET "Webhook検証用シークレット" "$(random_secret)" --secret)
WORKERS_AI_ACCOUNT_ID=$(prompt_value WORKERS_AI_ACCOUNT_ID "CloudflareアカウントID" "" --secret)
WORKERS_AI_API_TOKEN=$(prompt_value WORKERS_AI_API_TOKEN "Workers AI用CloudflareAPIトークン" "" --secret)
R2_ACCOUNT_ID=$(prompt_value R2_ACCOUNT_ID "CloudflareアカウントID(上と同じでよい)" "$WORKERS_AI_ACCOUNT_ID" --secret)
R2_ACCESS_KEY_ID=$(prompt_value R2_ACCESS_KEY_ID "R2用APIトークンのAccess Key ID" "" --secret)
R2_SECRET_ACCESS_KEY=$(prompt_value R2_SECRET_ACCESS_KEY "R2用APIトークンのSecret Access Key" "" --secret)
R2_BUCKET_NAME=$(prompt_value R2_BUCKET_NAME "R2バケット名" "genstory-oss-assets")
COMFYUI_URL=$(prompt_value COMFYUI_URL "自前ComfyUIのURL" "")

cat > "$ENV_FILE" << EOF
ORCHESTRATOR_TOKEN=${ORCHESTRATOR_TOKEN}
CF_WEBHOOK_SECRET=${CF_WEBHOOK_SECRET}
WORKERS_AI_ACCOUNT_ID=${WORKERS_AI_ACCOUNT_ID}
WORKERS_AI_API_TOKEN=${WORKERS_AI_API_TOKEN}
R2_ACCOUNT_ID=${R2_ACCOUNT_ID}
R2_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID}
R2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}
R2_BUCKET_NAME=${R2_BUCKET_NAME}
COMFYUI_URL=${COMFYUI_URL}
EOF

chmod 600 "$ENV_FILE"
echo ""
echo "作成しました: ${ENV_FILE} (パーミッション600)"

missing=""
for key in WORKERS_AI_ACCOUNT_ID WORKERS_AI_API_TOKEN R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  val=$(grep "^${key}=" "$ENV_FILE" | cut -d= -f2-)
  [ -z "$val" ] && missing="$missing $key"
done

if [ -n "$missing" ]; then
  echo "警告: 以下は空のまま保存されました。後で ${ENV_FILE} を直接編集してください:${missing}"
else
  echo "必須項目はすべて入力されました。"
fi
