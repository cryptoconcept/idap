'use client';
import React, { useEffect, useRef } from 'react';

const curlCommand = `curl https://your-idap.example/api/public/institutions`;

const jsonResponse = `{
  "institutionId": "inst_cbse_042",
  "slug": "sunrise-international-school",
  "institutionName": "Sunrise International School",
  "city": "Pune",
  "board": "CBSE",
  "total": 1,
  "page": 1,
  "pageSize": 20
}`;

const traits = [
  { label: 'No credentials in the browser', icon: '🔒' },
  { label: 'CORS-open for web clients', icon: '🌐' },
  { label: 'Per-IP rate-limited', icon: '⚡' },
  { label: '5-minute response cache', icon: '⏱' },
];

export default function DeveloperBand() {
  const sectionRef = useRef<HTMLElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cards = cardsRef.current?.querySelectorAll('[data-dev-reveal]');
    if (!cards) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLElement;
            el.classList.add('revealed');
            observer.unobserve(el);
          }
        });
      },
      { threshold: 0.1 }
    );
    cards.forEach((c) => observer.observe(c));
    return () => observer.disconnect();
  }, []);

  return (
    <section
      id="developers"
      ref={sectionRef}
      className="py-20 md:py-28"
      style={{ background: '#0c2d48' }}
    >
      <div className="container max-w-7xl mx-auto px-6" ref={cardsRef}>
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          {/* Left: copy */}
          <div data-dev-reveal className="reveal-on-scroll flex flex-col gap-6">
            <p className="text-xs font-semibold tracking-widest uppercase text-accent">
              Developers
            </p>
            <h2 className="font-display text-3xl md:text-4xl lg:text-5xl font-bold text-white leading-tight">
              Your website, powered by the same record<span className="text-marigold">.</span>
            </h2>
            <p className="text-white/60 text-lg leading-relaxed max-w-md">
              16 public REST endpoints. No authentication required for public data. Your CMS, your framework, your schedule — IDAP just serves the facts.
            </p>

            {/* Traits */}
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
              {traits.map((t) => (
                <li
                  key={t.label}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  <span className="text-lg">{t.icon}</span>
                  <span className="text-sm text-white/80 font-medium">{t.label}</span>
                </li>
              ))}
            </ul>

            <div className="pt-2">
              <a
                href="#"
                className="inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-white transition-colors duration-200 border-b border-accent/40 hover:border-white pb-0.5"
              >
                View API reference
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </a>
            </div>
          </div>

          {/* Right: code card */}
          <div data-dev-reveal className="reveal-on-scroll" style={{ transitionDelay: '0.15s' }}>
            <div
              className="rounded-2xl overflow-hidden"
              style={{
                background: '#060f1a',
                border: '1px solid rgba(255,255,255,0.08)',
                boxShadow: '0 32px 64px -16px rgba(0,0,0,0.5)',
              }}
            >
              {/* Terminal bar */}
              <div
                className="flex items-center gap-2 px-5 py-3"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
              >
                <span className="w-3 h-3 rounded-full bg-red-500/60" />
                <span className="w-3 h-3 rounded-full bg-yellow-500/60" />
                <span className="w-3 h-3 rounded-full bg-green-500/60" />
                <span className="ml-3 text-xs text-white/30 font-mono-code">
                  terminal
                </span>
              </div>

              {/* Curl command */}
              <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-xs text-white/30 mb-2 font-mono-code uppercase tracking-widest">
                  Request
                </p>
                <div className="flex items-start gap-2">
                  <span className="text-accent font-mono-code text-sm select-none">$</span>
                  <code className="text-sm text-white/90 font-mono-code leading-relaxed break-all">
                    {curlCommand}
                  </code>
                </div>
              </div>

              {/* JSON response */}
              <div className="px-5 py-4">
                <p className="text-xs text-white/30 mb-3 font-mono-code uppercase tracking-widest">
                  200 OK
                </p>
                <pre className="text-sm font-mono-code leading-relaxed overflow-x-auto">
                  {jsonResponse.split('\n').map((line, i) => {
                    const isKey = line.includes('":');
                    const keyMatch = line.match(/^(\s*)"([^"]+)":/);
                    const valueMatch = line.match(/:\s*(.+),?$/);
                    if (keyMatch && valueMatch) {
                      const indent = keyMatch[1];
                      const key = keyMatch[2];
                      const value = valueMatch[1].replace(/,$/, '');
                      const isString = value.startsWith('"');
                      const isNumber = !isNaN(Number(value));
                      return (
                        <div key={i}>
                          <span className="text-white/30">{indent}</span>
                          <span style={{ color: '#7dd3fc' }}>&quot;{key}&quot;</span>
                          <span className="text-white/50">: </span>
                          <span style={{ color: isString ? '#86efac' : isNumber ? '#fbbf24' : '#e2e8f0' }}>
                            {value}
                          </span>
                          {line.trim().endsWith(',') && <span className="text-white/30">,</span>}
                        </div>
                      );
                    }
                    return (
                      <div key={i}>
                        <span className="text-white/40">{line}</span>
                      </div>
                    );
                  })}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}