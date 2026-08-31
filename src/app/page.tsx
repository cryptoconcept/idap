import React from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import HeroSection from '@/app/components/HeroSection';
import SignatureDiagram from '@/app/components/SignatureDiagram';
import FeatureGrid from '@/app/components/FeatureGrid';
import PhotoBand from '@/app/components/PhotoBand';
import DeveloperBand from '@/app/components/DeveloperBand';
import ClosingCTA from '@/app/components/ClosingCTA';

export default function HomePage() {
  return (
    <main className="bg-background text-foreground overflow-x-hidden">
      <Header />
      <HeroSection />
      <SignatureDiagram />
      <FeatureGrid />
      <PhotoBand />
      <DeveloperBand />
      <ClosingCTA />
      <Footer />
    </main>
  );
}