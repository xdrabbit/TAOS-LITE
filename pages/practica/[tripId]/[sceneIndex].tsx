import type { GetServerSideProps } from "next";
import Head from "next/head";
import { PracticaSceneShell } from "@/components/practica/PracticaSceneShell";
import { practicaConfigured } from "@/lib/practica/access";
import { selectFaceProvider, type FaceKind } from "@/lib/practica/face";
import { practicaScene, practicaTrip, type PracticaScene, type PracticaTrip } from "@/lib/practica/scenes";

interface Props {
  configured: boolean;
  face: FaceKind;
  trip: PracticaTrip;
  scene: PracticaScene;
  sceneIndex: number;
}

export const getServerSideProps: GetServerSideProps<Props> = async ({ params }) => {
  const tripId = typeof params?.tripId === "string" ? params.tripId : "";
  const rawIndex = typeof params?.sceneIndex === "string" ? params.sceneIndex : "";
  const sceneIndex = /^\d+$/.test(rawIndex) ? Number(rawIndex) : -1;
  const trip = practicaTrip(tripId);
  const scene = practicaScene(tripId, sceneIndex);
  if (!trip || !scene) return { notFound: true };
  return {
    props: {
      configured: practicaConfigured(),
      face: selectFaceProvider(process.env.TAOS_PRACTICA_FACE),
      trip,
      scene,
      sceneIndex
    }
  };
};

export default function PracticaScenePage(props: Props): JSX.Element {
  return (
    <>
      <Head>
        <title>{props.configured ? `${props.scene.title.learner} · Practica con Liz` : "TAOS"}</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <PracticaSceneShell {...props} />
    </>
  );
}
