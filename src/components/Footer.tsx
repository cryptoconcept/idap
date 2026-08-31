import React from 'react';
import Link from 'next/link';
import AppLogo from '@/components/ui/AppLogo';

export default function Footer() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="container max-w-7xl mx-auto px-6 py-8">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          {/* Logo + wordmark */}
          <Link href="/" className="flex items-center gap-2">
            <AppLogo size={28} />
            <span className="font-display text-lg font-bold text-primary">
              IDAP<span className="text-marigold">.</span>
            </span>
          </Link>

          {/* Links */}
          <nav className="flex items-center gap-6 flex-wrap justify-center">
            <a
              href="#"
              className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
            >
              API Reference
            </a>
            <a
              href="#"
              className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
            >
              Privacy
            </a>
            <a
              href="#"
              className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
            >
              Terms
            </a>
          </nav>

          {/* Sign in + copyright */}
          <div className="flex items-center gap-4">
            <a
              href="#"
              className="text-sm font-semibold text-primary hover:text-primary/80 transition-colors"
            >
              Sign in
            </a>
            <span className="text-sm text-muted-foreground">© 2026 IDAP</span>
          </div>
        </div>
      </div>
    </footer>
  );
}