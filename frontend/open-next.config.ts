// OpenNext for Cloudflare の設定。
// `npx opennextjs-cloudflare build` 時に .open-next/worker.js を生成し、
// これを wrangler.jsonc の main が参照する(wrangler.jsonc自体もビルド時に自動生成される)。
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
