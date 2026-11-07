import type { GetServerSideProps } from "next";
import Head from "next/head";
import { PracticaHome } from "@/components/practica/PracticaHome";
import { practicaConfigured } from "@/lib/practica/access";

export const getServerSideProps: GetServerSideProps<{ configured: boolean }> = async () => ({
  props: { configured: practicaConfigured() }
});

export default function PracticaIndex({ configured }: { configured: boolean }): JSX.Element {
  return (
    <>
      <Head>
        <title>{configured ? "Practica con Liz · TAOS" : "TAOS"}</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <PracticaHome configured={configured} />
    </>
  );
}
