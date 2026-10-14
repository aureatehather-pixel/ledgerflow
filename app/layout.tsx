import type { ReactNode } from "react";

export const metadata = {
  title: "LedgerFlow",
  description: "Document intake for accounting firms",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
