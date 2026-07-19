#!/usr/bin/env bash
# scripts/provision-resources.sh
#
# KV namespace / R2 bucket が無ければ作成する冪等スクリプト。
# wrangler CLIの出力形式(コマンドによってJSON対応がまちまち)に依存せず、
# Cloudflare REST APIを直接叩くことで安定させている。
#
# 必須環境変数: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
# 実行後、workers/wrangler.jsonc の __KV_NAMESPACE_ID__ を実IDに書き換える。
#
# 何度実行しても安全(既存があれば再利用、無ければ作成するだけ)。

set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN が未設定です}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID が未設定です}"

API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"
KV_TITLE="genstory-oss-book-cache"
R2_BUCKET="genstory-oss-assets"
WRANGLER_JSONC="${WRANGLER_JSONC_PATH:-workers/wrangler.jsonc}"

api_call() {
  # api_call METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -X "$method" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "${API}${path}"
  else
    curl -s -X "$method" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      "${API}${path}"
  fi
}

check_success() {
  # check_success RESPONSE_JSON CONTEXT_LABEL
  local response="$1" context="$2"
  if [ "$(echo "$response" | jq -r '.success')" != "true" ]; then
    echo "::error::${context} に失敗しました。レスポンス:"
    echo "$response" | jq '.errors' >&2
    exit 1
  fi
}

echo "== KV namespace: ${KV_TITLE} =="
LIST_RESPONSE=$(api_call GET "/storage/kv/namespaces?per_page=100")
check_success "$LIST_RESPONSE" "KV namespace一覧取得"
KV_ID=$(echo "$LIST_RESPONSE" | jq -r --arg title "$KV_TITLE" '.result[] | select(.title == $title) | .id' | head -n1)

if [ -z "$KV_ID" ]; then
  echo "見つからないため新規作成します..."
  CREATE_RESPONSE=$(api_call POST "/storage/kv/namespaces" "{\"title\":\"${KV_TITLE}\"}")
  check_success "$CREATE_RESPONSE" "KV namespace作成"
  KV_ID=$(echo "$CREATE_RESPONSE" | jq -r '.result.id')
  echo "作成しました: ${KV_ID}"
else
  echo "既存のnamespaceを再利用します: ${KV_ID}"
fi

echo "== R2 bucket: ${R2_BUCKET} =="
R2_LIST_RESPONSE=$(api_call GET "/r2/buckets")
check_success "$R2_LIST_RESPONSE" "R2バケット一覧取得"
# APIバージョンによって .result.buckets[] か .result[] のどちらもあり得るため両対応
R2_EXISTS=$(echo "$R2_LIST_RESPONSE" | jq -r --arg name "$R2_BUCKET" '(.result.buckets // .result // [])[] | select(.name == $name) | .name')

if [ -z "$R2_EXISTS" ]; then
  echo "見つからないため新規作成します..."
  CREATE_RESPONSE=$(api_call POST "/r2/buckets" "{\"name\":\"${R2_BUCKET}\",\"locationHint\":\"apac\"}")
  check_success "$CREATE_RESPONSE" "R2バケット作成"
  echo "作成しました: ${R2_BUCKET}"
else
  echo "既存のバケットを使用します: ${R2_BUCKET}"
fi

sed -i "s/__KV_NAMESPACE_ID__/${KV_ID}/g" "$WRANGLER_JSONC"
echo "${WRANGLER_JSONC} へ KV namespace ID (${KV_ID}) を反映しました。"
