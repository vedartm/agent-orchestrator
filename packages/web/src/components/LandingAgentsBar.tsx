const agents = [
  {
    name: "Claude Code",
    src: "https://avatars.githubusercontent.com/u/76263028?s=64",
    alt: "Anthropic",
  },
  {
    name: "Codex",
    src: "https://avatars.githubusercontent.com/u/14957082?s=64",
    alt: "OpenAI",
  },
  {
    name: "Aider",
    src: "https://aider.chat/assets/logo.svg",
    alt: "Aider",
  },
  {
    name: "OpenCode",
    src: "https://avatars.githubusercontent.com/u/158794887?s=64",
    alt: "OpenCode",
  },
];

export function LandingAgentsBar() {
  return (
    <div className="landing-reveal text-center px-6 pt-[60px]">
      <div className="text-[0.6875rem] tracking-[0.15em] uppercase text-[var(--landing-muted)] opacity-40 mb-5">
        Works with your favorite AI agents
      </div>
      <div className="flex items-center justify-center gap-6 flex-wrap">
        {agents.map((agent) => (
          <div key={agent.name} className="flex flex-col items-center gap-2">
            <div className="landing-card w-14 h-14 rounded-[14px] flex items-center justify-center">
              <img
                src={agent.src}
                alt={agent.alt}
                className="w-8 h-8 rounded-md object-contain"
              />
            </div>
            <div className="text-[0.6875rem] font-mono text-[var(--landing-muted)] opacity-50">
              {agent.name}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
