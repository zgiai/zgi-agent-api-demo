import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZGI Agent API Demo",
  description: "A complete Next.js integration example for the ZGI Agent API",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
