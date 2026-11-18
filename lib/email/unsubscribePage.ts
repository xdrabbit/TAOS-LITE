// The page behind the footer's unsubscribe link (app/api/email/unsubscribe).
// Both languages at once: it is opened signed-out, from a mail client, and
// there is no telling which of the two people is holding the phone.

import { EMAIL_COPY } from "./copy";

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function unsubscribePage(valid: boolean): string {
  const { en, es } = EMAIL_COPY;
  const both = (key: "unsubDone" | "unsubWorking" | "unsubButton" | "unsubInvalid"): string =>
    `${esc(en[key])}<br><span lang="es">${esc(es[key])}</span>`;
  const body = valid
    ? `<p id="msg">${both("unsubWorking")}</p>
      <noscript><form method="post"><button type="submit">${esc(en.unsubButton)} · ${esc(es.unsubButton)}</button></form></noscript>
      <script>
        fetch(location.href, { method: "POST" }).then(function (r) {
          document.getElementById("msg").innerHTML = r.ok ? ${JSON.stringify(both("unsubDone"))} : ${JSON.stringify(both("unsubInvalid"))};
        }).catch(function () {
          document.getElementById("msg").innerHTML = ${JSON.stringify(both("unsubInvalid"))};
        });
      </script>`
    : `<p>${both("unsubInvalid")}</p>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>TAOS</title>
    <style>
      body { margin: 0; background: #14100e; color: #fde68a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      main { max-width: 24rem; margin: 18vh auto 0; padding: 0 1.25rem; font-size: 1rem; line-height: 1.6; }
      h1 { font-size: 1rem; letter-spacing: 0.04em; color: #f59e0b; }
      span { color: rgba(253, 230, 138, 0.7); }
      button { min-height: 44px; padding: 0 1.25rem; border-radius: 999px; border: 1px solid rgba(252, 211, 77, 0.3); background: rgba(251, 191, 36, 0.1); color: #fde68a; font-size: 1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>TAOS</h1>
      ${body}
    </main>
  </body>
</html>
`;
}

