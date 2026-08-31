"use client";

import { useEffect } from "react";

/**
 * The landing page's only JavaScript, both halves ported from the reference
 * implementation (github.com/cryptoconcept/idap):
 *
 * 1. Scroll reveals — watches `.reveal` / `.reveal-stagger` and stamps
 *    `.is-visible` on first intersection. The animation itself is CSS.
 * 2. Spotlight cards — the reference's FeatureGrid tracks the pointer at the
 *    document level and writes `--mouse-x`/`--mouse-y` into each
 *    `.spotlight-card`, which the CSS turns into a sky border glow under the
 *    cursor. rAF-throttled here so a mousemove flood costs one write per
 *    frame; the CSS default of -999px keeps the glow off-canvas until the
 *    first move, and without JS entirely.
 *
 * Renders nothing and holds no state — the page stays a server component
 * with one inert client leaf.
 */
export function RevealObserver() {
  useEffect(() => {
    const targets = document.querySelectorAll(".reveal, .reveal-stagger");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.18, rootMargin: "0px 0px -40px 0px" },
    );
    targets.forEach((target) => observer.observe(target));

    const cards = Array.from(document.querySelectorAll<HTMLElement>(".spotlight-card"));
    let frame = 0;
    const handleMouseMove = (event: MouseEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        for (const card of cards) {
          const rect = card.getBoundingClientRect();
          card.style.setProperty("--mouse-x", `${event.clientX - rect.left}px`);
          card.style.setProperty("--mouse-y", `${event.clientY - rect.top}px`);
        }
      });
    };
    document.addEventListener("mousemove", handleMouseMove);

    return () => {
      observer.disconnect();
      document.removeEventListener("mousemove", handleMouseMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
