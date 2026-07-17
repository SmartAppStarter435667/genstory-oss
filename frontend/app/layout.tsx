// frontend/app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "絵本をつくろう",
  description: "AIがテーマとキャラクターから、起承転結のある絵本を作ります。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="bg-amber-50/40 font-sans text-stone-900 antialiased">{children}</body>
    </html>
  );
}
