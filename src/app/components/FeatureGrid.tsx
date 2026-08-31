'use client';
import React, { useEffect, useRef } from 'react';
import Icon from '@/components/ui/AppIcon';

interface Feature {
  icon: string;
  title: string;
  description: string;
  accent: string;
  tag?: string;
}

const features: Feature[] = [
  {
    icon: 'BuildingOffice2Icon',
    title: 'Profile & Media',
    description: 'Canonical institution record: name, address, board affiliation, founding year, accreditations, logo, and photo gallery. One edit propagates everywhere.',
    accent: '#0ea5e9',
  },
  {
    icon: 'ClipboardDocumentListIcon',
    title: 'Admissions & Enquiries',
    description: 'Capture enquiries and track applications through your pipeline. Families apply once; you manage from a single dashboard.',
    accent: '#0e9f7e',
  },
  {
    icon: 'BanknotesIcon',
    title: 'Fee Structures',
    description: 'Publish grade-wise fee schedules to FeesBasket and your own website simultaneously. Update once, reflected everywhere within minutes.',
    accent: '#0284c7',
  },
  {
    icon: 'AcademicCapIcon',
    title: 'Results & Toppers',
    description: 'Board and internal results with per-student consent, withdrawable at any time. Powers PassPercent rankings without exposing private data.',
    accent: '#f5a524',
    tag: 'Consent-gated',
  },
  {
    icon: 'BriefcaseIcon',
    title: 'Teacher Vacancies',
    description: 'Post openings once — they appear on your careers page and syndicate to eduFleet Exchange. No duplicate entry, no stale listings.',
    accent: '#0e9f7e',
  },
  {
    icon: 'ShieldCheckIcon',
    title: 'Consent-First Connections',
    description: 'Grant each partner platform a scoped, named token. Revoke at any time from a single screen. No platform sees more than you permit.',
    accent: '#0c2d48',
    tag: 'Revocable',
  },
];

export default function FeatureGrid() {
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cards = gridRef.current?.querySelectorAll('[data-feature-card]');
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
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
    );

    cards.forEach((card) => observer.observe(card));

    const handleMouseMove = (e: MouseEvent) => {
      cards.forEach((card) => {
        const rect = (card as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        (card as HTMLElement).style.setProperty('--mouse-x', `${x}px`);
        (card as HTMLElement).style.setProperty('--mouse-y', `${y}px`);
      });
    };
    document.addEventListener('mousemove', handleMouseMove);

    return () => {
      observer.disconnect();
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  return (
    <section id="platform" className="py-20 md:py-28 bg-secondary/30 border-t border-border">
      <div className="container max-w-7xl mx-auto px-6">
        {/* Header */}
        <div className="max-w-2xl mb-14">
          <p className="text-xs font-semibold tracking-widest uppercase text-accent mb-3">
            Platform
          </p>
          <h2 className="font-display text-3xl md:text-4xl lg:text-5xl font-bold text-primary leading-tight">
            Everything a school manages<span className="text-marigold">.</span>
          </h2>
          <p className="mt-4 text-muted-foreground text-lg leading-relaxed">
            Six modules, one login. No spreadsheets, no duplicate data entry, no inconsistencies between your website and your applications.
          </p>
        </div>

        {/* Grid */}
        <div
          ref={gridRef}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5"
        >
          {features.map((f, i) => (
            <div
              key={f.title}
              data-feature-card
              className="reveal-on-scroll feature-card spotlight-card bg-card rounded-2xl p-7 border border-border flex flex-col gap-4 cursor-default"
              style={{ transitionDelay: `${i * 0.08}s` }}
            >
              {/* Icon */}
              <div
                className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: `${f.accent}18` }}
              >
                <Icon name={f.icon as Parameters<typeof Icon>[0]['name']} size={22} className="" style={{ color: f.accent }} />
              </div>

              {/* Title + tag */}
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-display text-lg font-semibold text-primary">{f.title}</h3>
                {f.tag && (
                  <span
                    className="text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full"
                    style={{ background: `${f.accent}18`, color: f.accent }}
                  >
                    {f.tag}
                  </span>
                )}
              </div>

              {/* Description */}
              <p className="text-muted-foreground text-sm leading-relaxed">{f.description}</p>

              {/* Accent line */}
              <div
                className="h-0.5 w-10 rounded-full mt-auto"
                style={{ background: f.accent }}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}