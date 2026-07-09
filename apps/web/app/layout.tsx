import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "인비즈톡",
  description: "PC-first business messenger MVP"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

