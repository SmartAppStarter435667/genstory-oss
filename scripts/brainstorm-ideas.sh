#!/usr/bin/env bash
# scripts/brainstorm-ideas.sh
#
# Cloudflare Workers AI(REST API)を直接呼び出し、絵本ネタ(テーマ・キャラクター・
# 舞台)を複数案生成して content/story-ideas/ にJSONとして保存する。
# v2: Ollama/self-hosted runnerが不要になり、ubuntu-latest上で完結する。
#
# 必須環境変数: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
# 任意環境変数: IDEA_COUNT(既定5), THEME_HINT

set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN が未設定です}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID が未設定です}"

COUNT="${IDEA_COUNT:-5}"
THEME_HINT="${THEME_HINT:-}"
MODEL="@cf/meta/llama-3.3-70b-instruct-fp8-fast"

SYSTEM_PROMPT="あなたは子供向け絵本のネタ出しを専門とする編集者です。多様な年齢層・テーマ・舞台のアイデアを、既存作品と被らないよう独創的に考えてください。各ネタには友情・思いやり・好奇心・環境・多様性などの教育的価値を1つ以上含めてください。暴力・恐怖・差別的表現は避けてください。"

HINT_TEXT=""
if [ -n "$THEME_HINT" ]; then
  HINT_TEXT="次のテーマ/季節を意識してください: ${THEME_HINT}"
fi
USER_PROMPT="${COUNT}個の絵本ネタを提案してください。${HINT_TEXT} 年齢層(3-5, 6-8, 9-12)をバランス良く混ぜ、テーマ・舞台・キャラクターが互いに重複しないようにしてください。"

echo "== Workers AIへリクエストを構築 =="
REQUEST_BODY=$(python3 -c "
import json, sys
system_prompt, user_prompt = sys.argv[1], sys.argv[2]
schema = {
    'type': 'object',
    'properties': {
        'ideas': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'id': {'type': 'string'},
                    'title_hint': {'type': 'string'},
                    'theme': {'type': 'string'},
                    'age_group': {'type': 'string', 'enum': ['3-5', '6-8', '9-12']},
                    'characters': {
                        'type': 'array',
                        'items': {
                            'type': 'object',
                            'properties': {
                                'name': {'type': 'string'},
                                'visual_description': {'type': 'string'},
                                'personality': {'type': 'string'},
                            },
                            'required': ['name', 'visual_description', 'personality'],
                        },
                    },
                    'setting': {'type': 'string'},
                    'seasonal_tag': {'type': 'string'},
                    'pitch': {'type': 'string'},
                },
                'required': ['id', 'title_hint', 'theme', 'age_group', 'characters', 'setting', 'pitch'],
            },
        },
    },
    'required': ['ideas'],
}
body = {
    'messages': [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': user_prompt},
    ],
    'response_format': {'type': 'json_schema', 'json_schema': schema},
}
print(json.dumps(body))
" "$SYSTEM_PROMPT" "$USER_PROMPT")

echo "== Workers AI(${MODEL})を呼び出し =="
RESPONSE=$(curl -sf -X POST \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${MODEL}" \
  -d "$REQUEST_BODY")

SUCCESS=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success'))")
if [ "$SUCCESS" != "True" ]; then
  echo "::error::Workers AI呼び出しに失敗しました: ${RESPONSE}" >&2
  exit 1
fi

TODAY=$(TZ=Asia/Tokyo date +%Y-%m-%d)
OUT_DIR="content/story-ideas"
mkdir -p "$OUT_DIR"
OUT_PATH="${OUT_DIR}/${TODAY}.json"

echo "== 結果を整形して保存 =="
echo "$RESPONSE" | python3 -c "
import json, sys, re

data = json.load(sys.stdin)
result = data['result']['response']
if isinstance(result, str):
    result = json.loads(result)

seen = set()
for i, idea in enumerate(result.get('ideas', [])):
    base = re.sub(r'[^a-zA-Z0-9]+', '-', (idea.get('id') or idea.get('title_hint') or f'idea-{i+1}')).strip('-').lower() or f'idea-{i+1}'
    slug, n = base, 2
    while slug in seen:
        slug = f'{base}-{n}'
        n += 1
    seen.add(slug)
    idea['id'] = slug

with open('${OUT_PATH}', 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f\"{len(result.get('ideas', []))}件のネタを書き出しました: ${OUT_PATH}\")
"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "output_path=$(pwd)/${OUT_PATH}" >> "$GITHUB_OUTPUT"
  IDEA_COUNT_OUT=$(python3 -c "import json; print(len(json.load(open('${OUT_PATH}'))['ideas']))")
  echo "idea_count=${IDEA_COUNT_OUT}" >> "$GITHUB_OUTPUT"
fi
