import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Darb · document matching",
  description:
    "Receipts and invoices arrive by WhatsApp and email, are extracted by OCR, and are matched to card transactions with an explainable confidence score.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The font variables must sit on <html>, not <body>: globals.css applies
    // `font-sans` to the html element, and CSS custom properties inherit downward only.
    // Defined on <body> they are invisible to <html>, and every surface silently falls
    // back to the browser's default serif.
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
