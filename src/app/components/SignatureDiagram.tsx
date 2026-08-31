'use client';
import React, { useEffect, useRef, useState } from 'react';

interface Destination {
  id: string;
  label: string;
  sublabel: string;
  dotColor: string;
  angle: number;
}

const destinations: Destination[] = [
  { id: 'website', label: 'Your Website', sublabel: 'Public REST API', dotColor: '#0ea5e9', angle: -135 },
  { id: 'feesbasket', label: 'FeesBasket', sublabel: 'Fee discovery', dotColor: '#0e9f7e', angle: -45 },
  { id: 'passpercent', label: 'PassPercent', sublabel: 'Results & rankings', dotColor: '#f5a524', angle: 45 },
  { id: 'edufleet', label: 'eduFleet Exchange', sublabel: 'Teacher hiring', dotColor: '#0284c7', angle: 135 },
];

// SVG layout constants
const CX = 250;
const CY = 220;
const CARD_W = 160;
const CARD_H = 72;
const DEST_RADIUS = 175;

function degToRad(deg: number) {
  return (deg * Math.PI) / 180;
}

function getDestPos(angle: number) {
  const rad = degToRad(angle);
  return {
    x: CX + DEST_RADIUS * Math.cos(rad),
    y: CY + DEST_RADIUS * Math.sin(rad),
  };
}

function getPathD(angle: number) {
  const dest = getDestPos(angle);
  const startX = CX;
  const startY = CY;
  const cp1x = startX + (dest.x - startX) * 0.5;
  const cp1y = startY;
  const cp2x = dest.x;
  const cp2y = dest.y - (dest.y - startY) * 0.3;
  return `M ${startX} ${startY} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${dest.x} ${dest.y}`;
}

export default function SignatureDiagram() {
  const sectionRef = useRef<HTMLElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [headerVisible, setHeaderVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setHeaderVisible(true);
            setTimeout(() => setDrawn(true), 300);
            observer.disconnect();
          }
        });
      },
      { threshold: 0.3 }
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      id="connections"
      ref={sectionRef}
      className="py-20 md:py-28 bg-background border-t border-border"
    >
      <div className="container max-w-5xl mx-auto px-6">
        {/* Header */}
        <div
          className="text-center mb-12 reveal-on-scroll"
          style={headerVisible ? { opacity: 1, transform: 'none', transition: 'opacity 0.7s ease, transform 0.7s ease' } : {}}
        >
          <p className="text-xs font-semibold tracking-widest uppercase text-accent mb-3">
            Enter it once. It travels.
          </p>
          <h2 className="font-display text-3xl md:text-4xl lg:text-5xl font-bold text-primary leading-tight">
            One record. Four destinations<span className="text-marigold">.</span>
          </h2>
          <p className="mt-4 text-muted-foreground text-lg max-w-2xl mx-auto">
            Your institution profile lives in IDAP. Every connected platform reads from the same record — with your explicit, revocable consent.
          </p>
        </div>

        {/* Diagram */}
        <div className="flex justify-center">
          <div className="relative w-full max-w-[500px]">
            <svg
              viewBox="0 0 500 440"
              className="w-full"
              aria-label="Diagram showing institution profile connecting to four platforms"
            >
              {/* Connector paths */}
              {destinations.map((dest, i) => {
                const d = getPathD(dest.angle);
                return (
                  <g key={dest.id}>
                    <path
                      d={d}
                      fill="none"
                      stroke={dest.dotColor}
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      opacity="0.4"
                      className={`connector-path${drawn ? ' drawn' : ''}`}
                      style={{ transitionDelay: `${i * 0.18}s` }}
                    />
                    {/* Travelling dot */}
                    {drawn && (
                      <circle r="4" fill={dest.dotColor} opacity="0.9">
                        <animateMotion
                          dur={`${2.2 + i * 0.4}s`}
                          repeatCount="indefinite"
                          path={d}
                          begin={`${i * 0.6}s`}
                        />
                      </circle>
                    )}
                  </g>
                );
              })}

              {/* Central card */}
              <g>
                <rect
                  x={CX - CARD_W / 2}
                  y={CY - CARD_H / 2}
                  width={CARD_W}
                  height={CARD_H}
                  rx="12"
                  fill="#0c2d48"
                />
                <text
                  x={CX}
                  y={CY - 14}
                  textAnchor="middle"
                  fill="white"
                  fontSize="11"
                  fontWeight="600"
                  fontFamily="DM Sans, sans-serif"
                >
                  Your institution profile
                </text>
                <text
                  x={CX}
                  y={CY + 4}
                  textAnchor="middle"
                  fill="rgba(224,242,254,0.75)"
                  fontSize="9"
                  fontFamily="DM Sans, sans-serif"
                >
                  profile · fees · results
                </text>
                <text
                  x={CX}
                  y={CY + 18}
                  textAnchor="middle"
                  fill="rgba(224,242,254,0.75)"
                  fontSize="9"
                  fontFamily="DM Sans, sans-serif"
                >
                  admissions · vacancies
                </text>
              </g>

              {/* Destination chips */}
              {destinations.map((dest) => {
                const pos = getDestPos(dest.angle);
                const chipW = 130;
                const chipH = 44;
                return (
                  <g key={dest.id}>
                    <rect
                      x={pos.x - chipW / 2}
                      y={pos.y - chipH / 2}
                      width={chipW}
                      height={chipH}
                      rx="22"
                      fill="white"
                      stroke={dest.dotColor}
                      strokeWidth="1.5"
                    />
                    <circle cx={pos.x - chipW / 2 + 16} cy={pos.y} r="5" fill={dest.dotColor} />
                    <text
                      x={pos.x - chipW / 2 + 28}
                      y={pos.y - 5}
                      fill="#0c2d48"
                      fontSize="9.5"
                      fontWeight="600"
                      fontFamily="DM Sans, sans-serif"
                    >
                      {dest.label}
                    </text>
                    <text
                      x={pos.x - chipW / 2 + 28}
                      y={pos.y + 9}
                      fill="#425a72"
                      fontSize="8"
                      fontFamily="DM Sans, sans-serif"
                    >
                      {dest.sublabel}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Consent note */}
        <div
          className="mt-8 text-center reveal-on-scroll"
          style={drawn ? { opacity: 1, transform: 'none', transition: 'opacity 0.7s ease 0.5s, transform 0.7s ease 0.5s' } : {}}
        >
          <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-secondary border border-border text-sm text-muted-foreground">
            <svg className="w-4 h-4 text-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            Every connection is consent-based — scoped, revocable, and logged.
          </span>
        </div>
      </div>
    </section>
  );
}