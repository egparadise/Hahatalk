import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HahaTalk",
  description: "PC-first 업무용 메신저와 허브 대화 MVP"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
