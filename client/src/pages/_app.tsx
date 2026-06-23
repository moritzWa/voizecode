import type { AppProps } from "next/app";
import { Inter } from "next/font/google";
import { ThemeProvider } from "@/components/ThemeProvider";
import "@/styles/globals.css";

const sans = Inter({ variable: "--font-sans", subsets: ["latin"] });

export default function App({ Component, pageProps }: AppProps) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <div className={`${sans.variable} font-sans antialiased`}>
        <Component {...pageProps} />
      </div>
    </ThemeProvider>
  );
}
