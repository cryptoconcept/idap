import { env } from "@/lib/env";

export const dynamic = "force-static";
export const revalidate = 300;

/**
 * Lightweight embed script. It renders two buttons that link to the hosted
 * application pages — no credentials ever reach the browser, which is why the
 * hosted page is the recommended integration over an embedded form.
 */
const SCRIPT = (appUrl: string) => `(function () {
  "use strict";

  var current = document.currentScript;
  if (!current) return;

  var institutionId = current.getAttribute("data-institution");
  if (!institutionId) {
    console.error("[admissions-widget] data-institution attribute is required");
    return;
  }

  var base = ${JSON.stringify(appUrl)};
  var layout = current.getAttribute("data-layout") || "inline";
  var enquiryLabel = current.getAttribute("data-enquiry-label") || "Admission Enquiry";
  var applyLabel = current.getAttribute("data-apply-label") || "Apply for Admission";

  var container = document.createElement("div");
  container.className = "aem-widget";
  container.setAttribute("data-institution", institutionId);

  var style = document.createElement("style");
  style.textContent = [
    ".aem-widget{display:flex;gap:10px;flex-wrap:wrap;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}",
    ".aem-widget[data-layout='stacked']{flex-direction:column}",
    ".aem-widget a{display:inline-flex;align-items:center;justify-content:center;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500;line-height:1;text-decoration:none;border:1px solid #111;transition:background-color .15s ease,color .15s ease}",
    ".aem-widget a.aem-primary{background:#111;color:#fff}",
    ".aem-widget a.aem-primary:hover{background:#333}",
    ".aem-widget a.aem-secondary{background:#fff;color:#111;border-color:#e5e5e5}",
    ".aem-widget a.aem-secondary:hover{border-color:#111}"
  ].join("");

  container.setAttribute("data-layout", layout);

  function link(href, label, variant) {
    var anchor = document.createElement("a");
    anchor.href = base + href;
    anchor.textContent = label;
    anchor.className = variant;
    anchor.rel = "noopener";
    return anchor;
  }

  container.appendChild(link("/apply/" + encodeURIComponent(institutionId) + "/enquiry", enquiryLabel, "aem-secondary"));
  container.appendChild(link("/apply/" + encodeURIComponent(institutionId), applyLabel, "aem-primary"));

  current.parentNode.insertBefore(style, current);
  current.parentNode.insertBefore(container, current);
})();
`;

export async function GET() {
  return new Response(SCRIPT(env.APP_URL), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
