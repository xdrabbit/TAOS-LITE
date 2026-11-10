import type { AppProps } from "next/app";
import "../app/globals.css";

export default function PracticaPagesApp({ Component, pageProps }: AppProps): JSX.Element {
  return <Component {...pageProps} />;
}
