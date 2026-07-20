#!/usr/bin/env bash
# scripts/setup-oci-runner.sh
#
# OCI VM上でGitHub Actions self-hosted runnerを登録し、systemdサービスとして
# 常駐化する。docs/github-actions-setup.md 手順6 の自動化版。
#
# 実行方法(OCI VM上で):
#   export GITHUB_PAT=ghp_xxxxx   # repo scopeのPersonal Access Token(privateリポジトリは必須)
#   export GITHUB_OWNER=SmartAppStarter435667
#   export GITHUB_REPO=genstory-book-ai
#   ./scripts/setup-oci-runner.sh
#
# 注意:
# - GITHUB_PATは「登録トークン」を取得するための一度きりの用途。
#   登録が終われば不要になるため、作業後はGitHub側
#   (Settings > Developer settings > Personal access tokens)で失効させることを推奨する。
# - 実際にconfig.shへ渡す登録トークンはここで動的取得したもので、約1時間で失効する
#   一時的なものなので、平文で保存されたりコミットされたりする心配はない。

set -euo pipefail

: "${GITHUB_PAT:?GITHUB_PAT が未設定です(repo scopeのPersonal Access Token)}"
: "${GITHUB_OWNER:?GITHUB_OWNER が未設定です(例: SmartAppStarter435667)}"
: "${GITHUB_REPO:?GITHUB_REPO が未設定です(例: genstory-book-ai)}"

RUNNER_LABELS="${RUNNER_LABELS:-oci-vm}"
RUNNER_NAME="${RUNNER_NAME:-$(hostname)-oci-vm}"
RUNNER_DIR="${RUNNER_DIR:-$HOME/actions-runner}"

echo "== 必要なツールを確認 =="
for cmd in curl python3 tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "${cmd} が見つからないためインストールします..."
    sudo apt-get update -y && sudo apt-get install -y "$cmd"
  fi
done

ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) RUNNER_ARCH="arm64" ;;
  x86_64) RUNNER_ARCH="x64" ;;
  *) echo "未対応のアーキテクチャです: ${ARCH}" >&2; exit 1 ;;
esac
echo "検出したアーキテクチャ: ${ARCH} -> ${RUNNER_ARCH}"

echo "== 1/4: 登録トークンを取得 =="
REG_RESPONSE=$(curl -sf -X POST \
  -H "Authorization: Bearer ${GITHUB_PAT}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runners/registration-token") || {
    echo "::error::GitHub APIへのリクエストに失敗しました。GITHUB_PAT/OWNER/REPOを確認してください。" >&2
    exit 1
  }
REG_TOKEN=$(echo "$REG_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))")

if [ -z "$REG_TOKEN" ]; then
  echo "::error::登録トークンの取得に失敗しました。レスポンス: ${REG_RESPONSE}" >&2
  exit 1
fi
echo "登録トークンを取得しました(約1時間有効)。"

echo "== 2/4: 最新版のrunnerパッケージを取得 =="
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

LATEST_VERSION=$(curl -sf https://api.github.com/repos/actions/runner/releases/latest \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'].lstrip('v'))")
echo "最新版: v${LATEST_VERSION}"

PACKAGE="actions-runner-linux-${RUNNER_ARCH}-${LATEST_VERSION}.tar.gz"
curl -sfL -o "$PACKAGE" \
  "https://github.com/actions/runner/releases/download/v${LATEST_VERSION}/${PACKAGE}"
tar xzf "$PACKAGE"
rm "$PACKAGE"

echo "== 3/4: config.sh で登録 =="
./config.sh --unattended \
  --url "https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}" \
  --token "$REG_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --replace

echo "== 4/4: systemdサービスとして常駐化 =="
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status

echo ""
echo "完了しました。GitHubの Settings > Actions > Runners で '${RUNNER_NAME}' が"
echo "ラベル '${RUNNER_LABELS}' 付きで Idle 表示になっているか確認してください。"
echo "確認できたら、GITHUB_PAT はGitHub側で失効させることを推奨します。"
