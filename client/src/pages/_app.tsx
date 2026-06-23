import type { AppProps } from "next/app";
import { useEffect } from "react";
import { Inter } from "next/font/google";
import { ThemeProvider } from "@/components/ThemeProvider";
import "@/styles/globals.css";

const sans = Inter({ variable: "--font-sans", subsets: ["latin"] });

export default function App({ Component, pageProps }: AppProps) {
  // Put the font variable on <html> too, so Radix portals (Select/menus rendered on <body>,
  // outside the wrapper div) inherit --font-sans instead of falling back to serif.
  useEffect(() => {
    for (const c of sans.variable.split(" ")) if (c) document.documentElement.classList.add(c);
  }, []);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <div className={`${sans.variable} font-sans antialiased`}>
        <Component {...pageProps} />
      </div>
    </ThemeProvider>
  );
}
