import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Verification Tool",
  description: "Verification Code Relay Tool — MVP foundation"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
