"use client";

export function LandingHero() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <video
        className="absolute inset-0 w-full h-full object-cover z-0"
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
      >
        <source
          src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260314_131748_f2ca2a28-fed7-44c8-b9a9-bd9acdd5ec31.mp4"
          type="video/mp4"
        />
      </video>
      <div className="absolute inset-0 z-[1] landing-hero-grid" />
      <section className="relative z-10 flex flex-col items-center justify-center text-center px-6 py-[90px] min-h-screen">
        <h1 className="landing-fade-rise font-normal text-[clamp(3rem,8vw,6rem)] leading-[0.95] tracking-[-2.46px] max-w-[80rem] [font-family:var(--font-instrument-serif,serif)]">
          Where agents work{" "}
          <em className="not-italic text-[var(--landing-muted)]">
            through the noise.
          </em>
        </h1>
        <p className="landing-fade-rise-d1 text-[var(--landing-muted)] text-[clamp(1rem,2vw,1.125rem)] max-w-[42rem] mt-8 leading-[1.7]">
          We&apos;re building the orchestration layer for AI-native engineering
          teams. Run 30 agents in parallel, each in its own worktree, shipping
          PRs while you focus on what matters.
        </p>
        <div className="landing-fade-rise-d2 landing-card rounded-full px-14 py-5 text-[0.9375rem] mt-12 font-mono tracking-normal">
          <span className="opacity-40">$</span> npx @composio/ao start
        </div>
      </section>
    </div>
  );
}
