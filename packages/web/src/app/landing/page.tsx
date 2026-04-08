import { LandingNav } from "@/components/LandingNav";
import { LandingHero } from "@/components/LandingHero";
import { LandingAbout } from "@/components/LandingAbout";
import { LandingAgentsBar } from "@/components/LandingAgentsBar";
import { LandingStats } from "@/components/LandingStats";
import { LandingVideo } from "@/components/LandingVideo";
import { LandingFeatures } from "@/components/LandingFeatures";
import { LandingDifferentiators } from "@/components/LandingDifferentiators";
import { LandingTestimonials } from "@/components/LandingTestimonials";
import { LandingHowItWorks } from "@/components/LandingHowItWorks";
import { LandingQuickStart } from "@/components/LandingQuickStart";
import { LandingCTA } from "@/components/LandingCTA";
import { ScrollRevealProvider } from "@/components/ScrollRevealProvider";

export default function LandingPage() {
  return (
    <ScrollRevealProvider>
      <LandingNav />
      <LandingHero />
      <LandingAbout />
      <LandingAgentsBar />
      <LandingFeatures />
      <LandingHowItWorks />
      <LandingDifferentiators />
      <LandingVideo />
      <LandingStats />
      <LandingTestimonials />
      <LandingQuickStart />
      <LandingCTA />
      <footer className="py-12 px-8 text-center text-[var(--landing-muted)] opacity-30 text-[0.8125rem] border-t border-white/[0.04]">
        MIT Licensed · Open Source · Built by ComposioHQ
      </footer>
    </ScrollRevealProvider>
  );
}
