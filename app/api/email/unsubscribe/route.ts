import { NextRequest, NextResponse } from "next/server";
import { supabasePrefsStore } from "@/lib/email/store";
import { isUuid, verifyUnsubscribe } from "@/lib/email/token";
import { unsubscribePage } from "@/lib/email/unsubscribePage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /api/email/unsubscribe?u=<user uuid>&s=<signature> — works signed-out.
//
// POST is the unsubscribe. It is what a mail client sends when somebody
// presses its own "Unsubscribe" button (the List-Unsubscribe-Post header,
// RFC 8058), and it answers with an empty 200. Immediate, and silent: no
// confirmation email, no "are you sure", no survey.
//
// GET is the link in the email's footer. It returns a tiny page that sends
// that same POST the moment it opens, so for a person it is still one click.
// It is a page rather than "GET unsubscribes" for one reason: mail scanners
// and link previewers FETCH every link in a message, and a GET that changes
// state would unsubscribe people who never touched it. A scanner does not run
// the page's script. With scripts off, the page shows one button.
//
// A bad or stale signature gets the same quiet page, saying the link is no
// longer valid and where the switch is in the app. Never a hint about whether
// the uuid exists.

async function verified(req: NextRequest): Promise<string | null> {
  const params = new URL(req.url).searchParams;
  const userId = params.get("u");
  const secret = (process.env.TAOS_EMAIL_LINK_SECRET ?? "").trim();
  if (!isUuid(userId) || !secret) return null;
  const found = await supabasePrefsStore.read(userId);
  if (found.state !== "ok" || !found.row) return null;
  return verifyUnsubscribe(userId, found.row.unsubscribe_token, secret, params.get("s")) ? userId : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await verified(req);
  if (!userId) return new NextResponse(null, { status: 400, headers: { "Cache-Control": "no-store" } });
  const done = await supabasePrefsStore.unsubscribe(userId);
  console.log(`[taos-daily-email] unsubscribe user=${userId} outcome=${done ? "done" : "failed"}`);
  return new NextResponse(null, { status: done ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const userId = await verified(req);
  return new NextResponse(unsubscribePage(Boolean(userId)), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
  });
}
