# content/story-ideas/

`.github/workflows/brainstorm-content.yml` が自動生成する絵本ネタの保管場所です。

- ファイル名は生成日(JST, `YYYY-MM-DD.json`)
- 実行のたびに同時にGitHub Issueが立ち、レビュー・採用可否をそこで判断する想定です
- 採用したネタの `theme` / `characters` / `age_group` はそのまま `langchain/story_chain.py` の `generate_storybook()` に渡せる形式です

手動で今すぐ生成したい場合は、GitHubの **Actions → Brainstorm Story Ideas → Run workflow** から実行できます(`count` や `theme_hint` を指定可能)。
