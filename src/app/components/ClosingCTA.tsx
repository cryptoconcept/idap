'use client';
import React, { useEffect, useRef } from 'react';

export default function ClosingCTA() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref?.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            el.classList.add('revealed');
            observer.disconnect();
          }
        });
      },
      { threshold: 0.3 }
    );
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);

  return (
    <section className="py-20 md:py-28 bg-background border-t border-border">
      <div className="container max-w-4xl mx-auto px-6">
        <div
          ref={ref}
          className="reveal-on-scroll rounded-3xl px-8 py-14 md:px-16 md:py-20 text-center flex flex-col items-center gap-8"
          style={{
            background: 'linear-gradient(140deg, #e0f2fe 0%, #eff7fe 50%, #f0f9ff 100%)',
            border: '1px solid #bae6fd',
          }}
        >
          {/* Badge */}
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-white/80 text-xs font-semibold tracking-widest uppercase text-accent">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            Ready when you are
          </span>

          <div className="flex flex-col gap-4">
            <h2 className="font-display text-3xl md:text-4xl lg:text-5xl font-bold text-primary leading-tight">
              Put your school&apos;s data to work<span className="text-marigold">.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto leading-relaxed">
              Sign in with your institution credentials and connect your first platform in under five minutes. No setup fee, no lock-in.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-4">
            <a
              href="#"
              className="inline-flex items-center justify-center gap-2 px-8 py-4 rounded-xl bg-primary text-primary-foreground text-base font-semibold hover:bg-primary/90 transition-all duration-200 shadow-lg shadow-primary/20"
            >
              Sign in to your institution
            </a>
            <a
              href="#developers"
              className="inline-flex items-center justify-center gap-2 px-8 py-4 rounded-xl border-2 border-primary text-primary text-base font-semibold hover:bg-primary/5 transition-all duration-200"
            >
              Explore the API
            </a>
          </div>

          {/* Stat row */}
          <div className="flex flex-wrap justify-center gap-8 pt-4 border-t border-border/60 w-full">
            {[
              ['3', 'connected platforms'],
              ['16', 'public API routes'],
              ['1,808', 'automated tests'],
            ]?.map(([val, label]) => (
              <div key={label} className="flex flex-col items-center gap-1">
                <span className="font-display text-2xl font-bold text-primary">{val}</span>
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}