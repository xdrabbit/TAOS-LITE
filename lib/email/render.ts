// The email, as a subject + HTML + plain text.
//
// What may appear in it is the whole point of this file's signature: a
// language, a phrase from lib/email/phrases.ts, a NUMBER of days, two URLs
// and the footer address. There is no parameter through which a person's own
// words could arrive.
//
// Old-fashioned HTML on purpose (tables, inline styles, no web fonts, no
// images): it has to survive Gmail, Apple Mail and Outlook, and an email with
// no remote images has nothing to block and nothing that tracks an open.

import { fill } from "@/lib/chrome/copy";
import { EMAIL_SOURCE } from "./config";
import { emailCopy, emailLang, type EmailLang } from "./copy";
import type { DailyPhrase } from "./phrases";

export type EmailKind = "daily" | "paused";
export type EmailDestination = "study" | "tutor";

export interface RenderInput {
  kind: EmailKind;
  /** The person's own language, from their saved pair at opt-in. */
  lang: string;
  phrase: DailyPhrase;
  /** Days visited in the last seven. A count; 0 hides the line. */
  daysThisWeek: number;
  destination: EmailDestination;
  /** https://taoslite.com — no trailing slash. */
  origin: string;
  unsubscribeUrl: string;
  /** TAOS_EMAIL_FOOTER_ADDRESS. The caller refuses to send without it. */
  footerAddress: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  openUrl: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Where the button goes. The marker is how opens are counted (counts only). */
export function openUrl(origin: string, destination: EmailDestination): string {
  return `${origin}/${destination}?src=${EMAIL_SOURCE}`;
}

/** The phrase in the language being LEARNED, and its meaning in the reader's. */
export function phraseSides(phrase: DailyPhrase, lang: EmailLang): { learn: string; meaning: string; learnLang: EmailLang } {
  return lang === "es"
    ? { learn: phrase.en, meaning: phrase.es, learnLang: "en" }
    : { learn: phrase.es, meaning: phrase.en, learnLang: "es" };
}

export function renderEmail(input: RenderInput): RenderedEmail {
  const lang = emailLang(input.lang);
  const c = emailCopy(lang);
  const url = openUrl(input.origin, input.destination);
  const sides = phraseSides(input.phrase, lang);
  const paused = input.kind === "paused";

  const subject = paused ? c.pausedSubject : fill(c.subject, { phrase: sides.learn });
  const preheader = paused ? c.pausedPreheader : c.preheader;
  const button = paused ? c.pausedButton : input.destination === "study" ? c.buttonStudy : c.buttonTutor;
  const days =
    !paused && input.daysThisWeek > 0
      ? input.daysThisWeek === 1
        ? c.daysOne
        : fill(c.daysMany, { days: input.daysThisWeek })
      : "";

  const body = paused
    ? `<p style="margin:0 0 6px;font-size:22px;line-height:1.3;font-weight:600;color:#3b2a14;">${esc(c.pausedTitle)}</p>
              <p style="margin:0 0 14px;font-size:16px;line-height:1.5;color:#4a3b28;">${esc(c.pausedBody)}</p>
              <p style="margin:0 0 22px;font-size:16px;line-height:1.5;color:#4a3b28;">${esc(c.pausedInvite)}</p>`
    : `<p style="margin:0 0 10px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#9a7b4f;">${esc(c.kicker)}</p>
              <p lang="${sides.learnLang}" style="margin:0 0 10px;font-size:28px;line-height:1.25;font-weight:600;color:#3b2a14;">${esc(sides.learn)}</p>
              <p style="margin:0 0 20px;font-size:16px;line-height:1.5;color:#6b5a44;">${esc(c.means)}: <span style="color:#3b2a14;">${esc(sides.meaning)}</span></p>
              <p style="margin:0 0 22px;font-size:16px;line-height:1.5;color:#4a3b28;">${esc(c.invite)}</p>`;

  const html = `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f0e6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f0e6;">
      <tr>
        <td align="center" style="padding:28px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;">
            <tr>
              <td style="padding:0 4px 14px;font-size:14px;font-weight:600;letter-spacing:0.04em;color:#b45309;">TAOS</td>
            </tr>
            <tr>
              <td style="background:#ffffff;border:1px solid #eadfcd;border-radius:18px;padding:26px 24px;">
              ${body}
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#b45309;border-radius:999px;">
                    <a href="${esc(url)}" style="display:inline-block;padding:13px 26px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">${esc(button)}</a>
                  </td>
                </tr>
              </table>${days ? `\n              <p style="margin:20px 0 0;font-size:14px;line-height:1.5;color:#6b5a44;">${esc(days)}</p>` : ""}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 6px 0;font-size:12px;line-height:1.6;color:#8a7a64;">
                ${esc(c.why)}
                <a href="${esc(input.unsubscribeUrl)}" style="color:#8a7a64;text-decoration:underline;">${esc(c.unsubscribe)}</a><br>
                ${esc(input.footerAddress)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

  const lines = paused
    ? [c.pausedTitle, "", c.pausedBody, "", c.pausedInvite, "", `${button}: ${url}`]
    : [
        `${c.kicker}: ${sides.learn}`,
        `${c.means}: ${sides.meaning}`,
        "",
        c.invite,
        "",
        `${button}: ${url}`,
        ...(days ? ["", days] : [])
      ];
  const text = [...lines, "", "--", c.why, `${c.unsubscribe}: ${input.unsubscribeUrl}`, input.footerAddress, ""].join("\n");

  return { subject, html, text, openUrl: url };
}
