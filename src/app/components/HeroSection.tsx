'use client';
import React, { useEffect, useRef } from 'react';
import AppImage from '@/components/ui/AppImage';

const stats = [
{ value: '3', label: 'connected platforms' },
{ value: '16', label: 'public API routes' },
{ value: '1,808', label: 'automated tests' }];


export default function HeroSection() {
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const els = sectionRef.current?.querySelectorAll('[data-hero-animate]');
    if (!els) return;
    els.forEach((el, i) => {
      const htmlEl = el as HTMLElement;
      htmlEl.style.animationDelay = `${i * 0.12}s`;
      htmlEl.classList.add('animate-in-hero');
    });
  }, []);

  return (
    <section
      ref={sectionRef}
      id="hero"
      className="hero-sky-gradient relative pt-28 pb-16 md:pt-36 md:pb-20 overflow-hidden">
      
      {/* Decorative sky orb */}
      <div
        className="pointer-events-none absolute -top-32 -right-32 w-[600px] h-[600px] rounded-full opacity-30"
        style={{ background: 'radial-gradient(circle, #bae6fd 0%, transparent 70%)' }} />
      

      <div className="container max-w-7xl mx-auto px-6 lg:px-8">
        <div className="grid lg:grid-cols-12 gap-12 items-center">
          {/* Left: Copy */}
          <div className="lg:col-span-6 xl:col-span-5 flex flex-col gap-6">
            {/* Eyebrow */}
            <div data-hero-animate className="opacity-0">
              <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-white/70 text-xs font-semibold tracking-widest uppercase text-accent">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-glow" />
                IDAP — Institution Data &amp; Admissions Platform
              </span>
            </div>

            {/* H1 */}
            <div data-hero-animate className="opacity-0">
              <h1 className="font-display text-[2.75rem] sm:text-5xl lg:text-[3.5rem] xl:text-[4rem] leading-[1.0] tracking-tight text-primary">
                One profile.{' '}
                <em className="not-italic" style={{ fontStyle: 'italic', fontFamily: 'Fraunces, serif' }}>
                  Everywhere
                </em>{' '}
                it matters
                <span className="text-marigold">.</span>
              </h1>
            </div>

            {/* Sub */}
            <div data-hero-animate className="opacity-0">
              <p className="text-muted-foreground text-lg leading-relaxed max-w-xl">
                A school keeps its single source of truth here — profile, fees, results, admissions, vacancies — and publishes it to its own website and the platforms families already use.{' '}
                <span className="text-primary font-medium">With the school&apos;s consent, every time.</span>
              </p>
            </div>

            {/* CTAs */}
            <div data-hero-animate className="opacity-0 flex flex-col sm:flex-row gap-3 pt-2">
              <a
                href="#"
                className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all duration-200 shadow-md shadow-primary/20">
                
                Sign in to your institution
              </a>
              <a
                href="#developers"
                className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl border-2 border-primary text-primary text-sm font-semibold hover:bg-primary/5 transition-all duration-200">
                
                Explore the API
              </a>
            </div>

            {/* Stat strip */}
            <div data-hero-animate className="opacity-0 flex flex-wrap gap-6 pt-4 border-t border-border">
              {stats.map((s, i) =>
              <div key={i} className="flex flex-col">
                  <span className="font-display text-2xl font-bold text-primary leading-none">
                    {s.value}
                  </span>
                  <span className="text-xs text-muted-foreground mt-0.5">{s.label}</span>
                </div>
              )}
            </div>
          </div>

          {/* Right: Photo composition */}
          <div className="lg:col-span-6 xl:col-span-7 relative flex items-center justify-center min-h-[400px] md:min-h-[480px]">
            {/* Main classroom photo */}
            <div
              data-hero-animate
              className="opacity-0 relative w-full max-w-[580px] rounded-2xl overflow-hidden shadow-2xl shadow-primary/10 border border-border"
              style={{ aspectRatio: '4/3' }}>
              
              <AppImage
                src="https://img.rocket.new/generatedImages/rocket_gen_img_1fdf5d483-1779709133676.png"
                alt="Bright classroom with students seated at desks, large windows with natural light, teacher at whiteboard, clean modern school interior"
                fill
                className="object-cover"
                priority
                sizes="(max-width: 768px) 100vw, 55vw" />
              
              <div className="absolute inset-0 bg-gradient-to-t from-primary/20 via-transparent to-transparent" />
            </div>

            {/* Floating card A — top-left */}
            <div className="animate-float-a absolute -left-4 top-4 md:-left-10 md:top-8 w-36 md:w-44 rounded-xl overflow-hidden shadow-xl border-2 border-white photo-card-tilt-left">
              <AppImage
                src="https://img.rocket.new/generatedImages/rocket_gen_img_195ba2d1e-1766737604713.png"
                alt="Teacher explaining lesson to attentive students in a bright classroom, warm afternoon light"
                width={176}
                height={120}
                className="object-cover w-full h-24 md:h-28" />
              
            </div>

            {/* Floating card B — bottom-right */}
            <div className="animate-float-b absolute -right-4 bottom-4 md:-right-8 md:bottom-8 w-36 md:w-44 rounded-xl overflow-hidden shadow-xl border-2 border-white photo-card-tilt-right">
              <AppImage
                src="https://img.rocket.new/generatedImages/rocket_gen_img_188ab462b-1784734743020.png"
                alt="Students in school library browsing books, warm reading room with wooden shelves and soft lighting"
                width={176}
                height={120}
                className="object-cover w-full h-24 md:h-28" />
              
            </div>
          </div>
        </div>
      </div>
    </section>);

}