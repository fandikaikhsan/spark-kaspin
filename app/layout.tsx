import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kaspin POS Analytics",
  description: "Daily item sales and transaction activity from the POS system.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
