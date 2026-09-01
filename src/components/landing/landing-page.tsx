import Image from "next/image";
import Link from "next/link";
import { DM_Sans, Fraunces, JetBrains_Mono } from "next/font/google";
import { RevealObserver } from "./reveal";
import { OnboardedInstitutions } from "./onboarded";
import "./landing.css";

/**
 * The marketing face of the product, at `/` for signed-out visitors.
 *
 * The page argues one thesis — enter it once, it shows up everywhere — which
 * is literally what the platform does: a school's profile, fees, results and
 * vacancies live here and syndicate to its own website (the public Website
 * API) and to the three connected platforms, behind the school's consent.
 * Every number and endpoint on this page is real; nothing is aspirational
 * copy about features that don't exist.
 *
 * Display type is Fraunces, loaded here rather than in the root layout so the
 * product UI keeps its Geist-only setup — the serif belongs to the brand
 * voice, not to dashboards.
 */
const fraunces = Fraunces({
  subsets: ["latin"],
  style: ["normal", "italic"],
  // The reference's weight set. 700 matters most: the section headings are
  // font-bold, and a weight the font doesn't ship makes the browser smear a
  // synthetic bold over the 600 face — visibly wrong in a serif.
  weight: ["300", "400", "600", "700", "900"],
  variable: "--font-fraunces",
  display: "swap",
});

/* The reference sets the landing's body face to DM Sans and its code to
   JetBrains Mono; both load here, scoped to this subtree, so the product UI
   keeps Geist. */
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jb-mono",
  display: "swap",
});

const display = "font-[family-name:var(--font-fraunces)]";

/* Every photo below was verified to resolve (HTTP 200) before shipping. */
const photo = (id: string, w: number) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=80`;

const MARQUEE_TOP = [
  { id: "1580582932707-520aed937b7b", alt: "A teacher writing on a classroom blackboard" },
  { id: "1497633762265-9d179a990aa6", alt: "A stack of open textbooks" },
  { id: "1546410531-bb4caa6b424d", alt: "A teacher explaining a lesson at the board" },
  { id: "1541339907198-e08756dedf3f", alt: "A university campus building" },
  { id: "1522202176988-66273c2fd55f", alt: "Students studying together on laptops" },
];

const MARQUEE_BOTTOM = [
  { id: "1571260899304-425eee4c7efc", alt: "Graduates in gowns at a ceremony" },
  { id: "1588072432836-e10032774350", alt: "A child attending an online class" },
  { id: "1427504494785-3a9ca7044f45", alt: "A teacher smiling in a classroom" },
  { id: "1523240795612-9a054b0db644", alt: "Two students reviewing notes together" },
  { id: "1544717297-fa95b6ee9643", alt: "Children reading in a school library" },
];

const FEATURES = [
  {
    title: "Profile & media",
    body: "One living profile — identity, academics, facilities, achievements, alumni, photos and videos — published when the school says so, and only then.",
  },
  {
    title: "Admissions & enquiries",
    body: "Leads and applications flow in from the school's own website through the public API, into one pipeline with notes, assignment and follow-ups.",
  },
  {
    title: "Fee structures",
    body: "Structured, versioned fee tables per class and academic year — the same record that powers the website powers FeesBasket.",
  },
  {
    title: "Results & toppers",
    body: "Exam-cycle results with per-topper consent. Withdraw a consent and that student leaves the API on the very next read.",
  },
  {
    title: "Teacher vacancies",
    body: "Open roles on the school's careers page and syndicated to eduFleet Exchange — closed roles come down everywhere at once.",
  },
  {
    title: "Consent-first connections",
    body: "Every platform link is granted by the school, scoped to what it covers, and revocable any time. A revoked grant disconnects — visibly.",
  },
];

const DESTINATIONS = [
  { name: "Your website", note: "Public Website API — CORS-open, no credentials", accent: "var(--teal-blue)" },
  { name: "FeesBasket", note: "Fee discovery families already use", accent: "var(--green)" },
  { name: "PassPercent", note: "Results and school rankings", accent: "var(--amber)" },
  { name: "eduFleet Exchange", note: "Teacher hiring, both contracts", accent: "var(--teal)" },
];

function MarqueeRow({ items, reverse }: { items: typeof MARQUEE_TOP; reverse?: boolean }) {
  // The track holds its content twice; the keyframe travels half the track
  // width, so the loop point is invisible.
  const doubled = [...items, ...items];
  return (
    <div className={`marquee ${reverse ? "marquee-reverse" : ""}`} aria-hidden={reverse}>
      {doubled.map((item, index) => (
        <div key={`${item.id}-${index}`} className="marquee-card relative h-44 w-64 sm:h-52 sm:w-80">
          <Image
            src={photo(item.id, 640)}
            alt={index < items.length && !reverse ? item.alt : ""}
            fill
            sizes="320px"
            className="object-cover"
          />
        </div>
      ))}
    </div>
  );
}

export async function LandingPage() {
  return (
    <div
      className={`landing ${fraunces.variable} ${dmSans.variable} ${jetBrainsMono.variable} font-[family-name:var(--font-dm-sans)]`}
    >
      <RevealObserver />

      {/* Audit flows-L1: reveal sections default to opacity:0 and are shown by
          the observer's .is-visible class. Without JS (and without a
          reduced-motion preference) they would stay blank — so with JS off,
          force them visible. */}
      <noscript>
        <style>{`.reveal,.reveal-stagger > *{opacity:1 !important;transform:none !important;}`}</style>
      </noscript>

      {/* ------------------------------------------------------- header */}
      <header className="landing-header">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link href="/" className="flex items-center">
            <Image
              src="/brand/idap-logo.png"
              alt="IDAP — Institution Digital Appearance Platform"
              width={122}
              height={48}
              priority
              className="h-12 w-auto"
            />
          </Link>
          <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
            <a href="#platform" className="transition-colors hover:text-foreground">Platform</a>
            <a href="#connected" className="transition-colors hover:text-foreground">Connections</a>
            <a href="#developers" className="transition-colors hover:text-foreground">Developers</a>
          </nav>
          <Link
            href="/login"
            className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-transform hover:-translate-y-0.5"
          >
            Sign in
          </Link>
        </div>
      </header>

      {/* --------------------------------------------------------- hero */}
      <section className="landing-hero">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-16 md:grid-cols-[1.1fr_1fr] md:pb-28 md:pt-24">
          <div>
            <p className="hero-enter hero-enter-1 text-xs font-semibold uppercase tracking-widest text-accent">
              IDAP — Institution Digital Appearance Platform
            </p>
            <h1 className={`${display} hero-enter hero-enter-2 mt-5 text-[2.75rem] leading-[1.0] tracking-tight sm:text-5xl lg:text-[3.5rem] xl:text-[4rem]`}>
              One profile.
              <br />
              <em className="font-medium">Everywhere</em> it matters<span className="hero-dot">.</span>
            </h1>
            <p className="hero-enter hero-enter-3 mt-6 max-w-lg text-lg leading-relaxed text-muted-foreground">
              A school keeps its single source of truth here — profile, fees, results, admissions,
              vacancies — and publishes it to its own website and the platforms families already
              use. With the school&apos;s consent, every time.
            </p>
            <div className="hero-enter hero-enter-4 mt-9 flex flex-wrap items-center gap-4">
              <Link
                href="/login"
                className="rounded-full bg-primary px-7 py-3 text-sm font-medium text-primary-foreground transition-transform hover:-translate-y-0.5"
              >
                Sign in to your institution
              </Link>
              <a
                href="#developers"
                className="rounded-full border border-border px-7 py-3 text-sm font-medium transition-colors hover:border-ring"
              >
                Explore the API
              </a>
            </div>
            <dl className="hero-enter hero-enter-4 mt-12 flex gap-10 border-t border-border pt-6">
              {[
                ["3", "connected platforms"],
                ["16", "public API routes"],
                ["1,808", "automated tests"],
              ].map(([value, label]) => (
                <div key={label}>
                  <dt className="sr-only">{label}</dt>
                  <dd className={`${display} text-2xl font-semibold tabular`}>{value}</dd>
                  <dd className="mt-1 text-xs text-muted-foreground">{label}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="hero-enter hero-enter-3 relative hidden md:block">
            <div className="hero-photo-main relative aspect-[4/5] overflow-hidden">
              <Image
                src={photo("1577896851231-70ef18881754", 1000)}
                alt="Schoolchildren raising their hands in a bright classroom"
                fill
                priority
                sizes="(min-width: 768px) 40vw, 90vw"
                className="object-cover"
              />
            </div>
            <div className="hero-float absolute -left-10 top-10 hidden aspect-[4/3] w-44 overflow-hidden lg:block">
              <Image
                src={photo("1509062522246-3755977927d7", 400)}
                alt=""
                fill
                sizes="176px"
                className="object-cover"
              />
            </div>
            <div className="hero-float hero-float-slow absolute -bottom-8 -right-6 aspect-square w-40 overflow-hidden">
              <Image
                src={photo("1503676260728-1c00da094a0b", 400)}
                alt=""
                fill
                sizes="160px"
                className="object-cover"
              />
            </div>
          </div>
        </div>
      </section>

      <OnboardedInstitutions />

      {/* -------------------------------------------- syndication (signature) */}
      <section id="connected" className="border-y border-border bg-muted/60 py-20 md:py-28">
        <div className="mx-auto max-w-6xl px-5">
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-accent">
              Enter it once. It travels.
            </p>
            <h2 className={`${display} text-3xl font-bold leading-tight md:text-4xl lg:text-5xl`}>
              One record. Four destinations<span className="hero-dot">.</span>
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
              Edit a fee table, publish a result, open a vacancy — the change lands everywhere the
              school has said it should, and nowhere it hasn&apos;t.
            </p>
          </div>

          <div className="reveal relative mt-16">
            {/* Connectors: drawn once on reveal, dots keep traveling. Percent-space
                paths with non-scaling strokes keep the lines true at any width. */}
            <svg
              className="absolute inset-0 hidden h-full w-full md:block"
              viewBox="0 0 100 44"
              preserveAspectRatio="none"
              aria-hidden
            >
              {/* Each connector wears its destination's accent, exactly as
                  the reference colors them (stroke opacity 0.4, round caps),
                  and the dot travels in the same color. */}
              {[
                "M 50 22 C 38 22, 30 8, 15 7",
                "M 50 22 C 62 22, 70 8, 85 7",
                "M 50 22 C 38 22, 30 36, 15 37",
                "M 50 22 C 62 22, 70 36, 85 37",
              ].map((d, index) => (
                <g key={d}>
                  <path
                    d={d}
                    className={`syn-path${index > 0 ? ` syn-path-${index + 1}` : ""}`}
                    fill="none"
                    stroke={DESTINATIONS[index].accent}
                    strokeOpacity="0.4"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle r="0.55" fill={DESTINATIONS[index].accent} opacity="0.9" className="syn-dot">
                    <animateMotion
                      dur={`${2.2 + index * 0.4}s`}
                      begin={`${index * 0.6}s`}
                      repeatCount="indefinite"
                      path={d}
                    />
                  </circle>
                </g>
              ))}
            </svg>

            <div className="relative grid gap-4 md:h-[420px] md:grid-cols-2">
              {/* Center: the record itself. */}
              <div className="syn-core landing-card z-10 mx-auto flex w-full max-w-xs flex-col justify-center gap-1 px-6 py-5 text-center md:absolute md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2">
                <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  The record
                </p>
                <p className={`${display} text-lg font-semibold`}>Your institution profile</p>
                <p className="text-xs text-muted-foreground">profile · fees · results · vacancies</p>
              </div>

              {/* Destinations, pinned to the connector endpoints on desktop. */}
              {DESTINATIONS.map((destination, index) => {
                const anchors = [
                  "md:left-[4%] md:top-[4%]",
                  "md:right-[4%] md:top-[4%]",
                  "md:bottom-[4%] md:left-[4%]",
                  "md:bottom-[4%] md:right-[4%]",
                ];
                return (
                  <div
                    key={destination.name}
                    className={`syn-node landing-card spotlight-card z-10 w-full max-w-xs px-5 py-4 md:absolute ${anchors[index]}`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: destination.accent }}
                        aria-hidden
                      />
                      <p className="text-sm font-semibold">{destination.name}</p>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">{destination.note}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ features */}
      <section id="platform" className="py-20 md:py-28">
        <div className="mx-auto max-w-6xl px-5">
          <div className="reveal max-w-2xl">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-accent">Platform</p>
            <h2 className={`${display} text-3xl font-bold leading-tight md:text-4xl lg:text-5xl`}>
              Everything a school manages<span className="hero-dot">.</span>
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              Not a website builder, not a portal login — the operating record underneath all of
              them.
            </p>
          </div>
          <div className="reveal-stagger mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="landing-card spotlight-card px-6 py-6">
                <h3 className="text-base font-semibold">{feature.title}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------- photo band */}
      <section className="overflow-hidden border-y border-border bg-muted/60 py-16" aria-label="Schools in pictures">
        <div className="reveal mx-auto mb-10 max-w-6xl px-5 text-center">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-accent">
            Schools across India
          </p>
          <h2 className={`${display} text-2xl font-bold md:text-3xl`}>
            Built for the institutions that shape futures<span className="hero-dot">.</span>
          </h2>
        </div>
        <div className="reveal space-y-5">
          <MarqueeRow items={MARQUEE_TOP} />
          <MarqueeRow items={MARQUEE_BOTTOM} reverse />
        </div>
      </section>

      {/* ---------------------------------------------------- developers */}
      <section id="developers" className="landing-dev py-20 md:py-28">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 md:grid-cols-2">
          <div className="reveal">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-accent">
              Developers
            </p>
            <h2 className={`${display} text-3xl font-bold leading-tight md:text-4xl lg:text-5xl`}>
              Your website, powered by the same record<span className="hero-dot">.</span>
            </h2>
            <p className="dev-muted mt-4 text-lg leading-relaxed">
              A static site — or any site — reads the school&apos;s published data straight from the
              Website API. No credentials in the browser, CORS-open, rate-limited per IP, cached
              five minutes. The directory, the full profile, fees, results, scholarships, offers
              and open vacancies are all one <code className="font-[family-name:var(--font-jb-mono)] text-sm">GET</code> away.
            </p>
            <a
              href="/api/v1/openapi.yaml"
              className="mt-7 inline-block rounded-full border border-[#234356] px-6 py-2.5 text-sm font-medium transition-colors hover:border-[#8fb3c4]"
            >
              Read the OpenAPI spec
            </a>
          </div>
          <div className="reveal dev-code overflow-x-auto p-5 font-[family-name:var(--font-jb-mono)] text-xs leading-relaxed">
            <p className="dev-muted"># the public directory — no key needed</p>
            <p className="mt-1">curl https://your-idap.example/api/public/institutions</p>
            <pre className="dev-muted mt-4">{`{
  "success": true,
  "institutions": [{
    "institutionId": "INS0001",
    "slug": "infinity-school-of-excellence-mysore",
    "institutionName": "Infinity School of Excellence",
    "city": "Mysore", "board": "CBSE"
  }],
  "total": 137, "page": 1, "pageSize": 20
}`}</pre>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- closing CTA */}
      <section className="py-20 md:py-24">
        <div className="mx-auto max-w-6xl px-5">
          <div className="reveal landing-hero rounded-3xl border border-border px-8 py-14 text-center md:py-20">
            <span className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-paper px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              Ready when you are
            </span>
            <h2 className={`${display} mx-auto max-w-xl text-3xl font-bold leading-tight md:text-4xl lg:text-5xl`}>
              Put your school&apos;s data to work<span className="hero-dot">.</span>
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-muted-foreground">
              Sign in, finish your profile, and publish it once — everywhere.
            </p>
            <Link
              href="/login"
              className="mt-8 inline-block rounded-full bg-primary px-8 py-3 text-sm font-medium text-primary-foreground transition-transform hover:-translate-y-0.5"
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 text-sm text-muted-foreground md:flex-row">
          <Image
            src="/brand/idap-logo.png"
            alt="IDAP — Institution Digital Appearance Platform"
            width={203}
            height={80}
            className="h-20 w-auto"
          />
          <nav className="flex gap-6">
            <a href="/api/v1/openapi.yaml" className="transition-colors hover:text-foreground">
              API reference
            </a>
            <Link href="/login" className="transition-colors hover:text-foreground">
              Sign in
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
