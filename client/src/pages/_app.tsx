import type { AppProps } from "next/app";
import Head from "next/head";
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
      <Head>
        {/* maximum-scale=1 stops iOS Safari auto-zooming on input focus; pinch-zoom still works
            (Safari ignores the cap for user-initiated zoom since iOS 10). */}
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </Head>
      <div className={`${sans.variable} font-sans antialiased`}>
        <Component {...pageProps} />
      </div>
    </ThemeProvider>
  );
}
