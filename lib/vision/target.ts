// Which language a photo comes back in.
//
// A photographed menu, sign, or label is not a conversation: nobody is talking
// back, so there is only one useful answer — YOUR language, the one you can
// read. That is already on file. /translate's pills save the pair as
// [yours, theirs] (lib/translate/pair.ts), so the photo target is the pair's
// own side, and the trip languages come along for free: Tom photographing a
// Mostar menu with the pair at [en, bs] gets English, Liz at [es, bs] gets
// Spanish, and neither of them picks a language twice.
//
// Deliberately NOT the selected pill (pair[1]): that is the language you are
// speaking INTO, which for a photo would hand Tom a Bosnian menu translated
// into Bosnian.
//
// The source language is never part of this — the photo tells us what it is.
// /api/vision detects it from the image text, which is the only thing that
// works when the sign in front of you could be Bosnian, Croatian, or Serbian.

import { type PairLangCode } from "@/lib/translate/pair";

// No saved pair yet (a phone that has opened /vision before it ever opened
// /translate). The route's standing auto rule takes over: English text →
// Spanish, anything else → English.
export const PHOTO_TARGET_AUTO = "auto";

export type PhotoTarget = PairLangCode | typeof PHOTO_TARGET_AUTO;

export function photoTargetLanguage(
  pair: readonly [PairLangCode, PairLangCode] | null | undefined
): PhotoTarget {
  return pair ? pair[0] : PHOTO_TARGET_AUTO;
}
