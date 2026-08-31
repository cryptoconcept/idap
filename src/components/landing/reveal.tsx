"use client";

import { useEffect } from "react";

/**
 * The landing page's only JavaScript: watches every `.reveal` and
 * `.reveal-stagger` element and stamps `.is-visible` the first time it
 * scrolls into view. The animation itself is entirely CSS — this component
 * renders nothing and holds no state, so the page stays a server component
 * with one inert client leaf.
 *
 * If JS never runs (crawler, reader mode), a no-JS rule is NOT needed:
 * `prefers-reduced-motion` already forces every reveal visible, and for the
 * scripted-but-motion-tolerant case the observer fires on mount for anything
 * already in the viewport, so nothing above the fold waits for a scroll.
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
    return () => observer.disconnect();
  }, []);

  return null;
}
