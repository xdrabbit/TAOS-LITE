"use client";

import { useEffect, useRef } from "react";
import type { CourseId } from "@/lib/tutor/course";
import { loadMastery, saveMastery } from "@/lib/tutor/masteryStorage";
import { syncMastery } from "@/lib/tutor/masterySync";
import { supabase } from "@/lib/supabase";

const COURSE_IDS: CourseId[] = ["tom-spanish-1", "liz-english-1"];
const RELOAD_FLAG = "taos.tutor.mastery.sync-reloaded";

function sameRecords(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function TutorMasterySyncBridge(): null {
  const syncingRef = useRef(false);

  useEffect(() => {
    let active = true;

    async function syncCourses(courseIds: CourseId[], allowReload: boolean) {
      if (syncingRef.current) return;
      syncingRef.current = true;
      let changed = false;
      try {
        for (const courseId of courseIds) {
          const local = loadMastery(courseId);
          try {
            const merged = await syncMastery(courseId, local);
            if (!sameRecords(local, merged)) {
              saveMastery(courseId, merged, false);
              changed = true;
            }
          } catch {
            // Sync is best-effort. The local/offline Tutor must keep working.
          }
        }
      } finally {
        syncingRef.current = false;
      }

      if (!active || !allowReload || !changed || typeof window === "undefined") return;
      if (window.sessionStorage.getItem(RELOAD_FLAG) === "1") return;
      window.sessionStorage.setItem(RELOAD_FLAG, "1");
      window.location.reload();
    }

    void syncCourses(COURSE_IDS, true);

    const { data: authSub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) return;
      if (typeof window !== "undefined") window.sessionStorage.removeItem(RELOAD_FLAG);
      void syncCourses(COURSE_IDS, true);
    });

    function onMasteryChanged(event: Event) {
      const courseId = (event as CustomEvent<{ courseId?: CourseId }>).detail?.courseId;
      void syncCourses(courseId ? [courseId] : COURSE_IDS, false);
    }

    function onVisible() {
      if (document.visibilityState === "visible") void syncCourses(COURSE_IDS, false);
    }

    window.addEventListener("taos:tutor-mastery-changed", onMasteryChanged);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      active = false;
      authSub.subscription.unsubscribe();
      window.removeEventListener("taos:tutor-mastery-changed", onMasteryChanged);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
