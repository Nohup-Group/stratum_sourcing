import { Badge } from "@/components/ui/badge";

const SUGGESTIONS = [
  "Summarize the latest sourcing themes from recent notes",
  "Draft a founder outreach angle for an AI infrastructure company",
  "Compare three candidate sectors for the next Stratum thesis sprint",
  "Turn rough diligence notes into a clean investment memo outline",
];

export default function WelcomeContent() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-12 text-center sm:py-20">
      <img
        src="/logo-mark.png"
        alt="Stratum mark"
        className="mb-6 h-auto w-20 drop-shadow-[0_18px_40px_rgba(78,0,255,0.22)] sm:w-24"
      />

      <img
        src="/logo-lockup-light.png"
        alt="Stratum"
        className="mb-4 block h-auto w-[min(22rem,78vw)] dark:hidden"
      />
      <img
        src="/logo-lockup-dark.png"
        alt="Stratum"
        className="mb-4 hidden h-auto w-[min(22rem,78vw)] dark:block"
      />

      <h1 className="max-w-2xl text-balance text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-5xl">
        A sharper workspace for Stratum sourcing conversations.
      </h1>
      <p className="mt-4 max-w-2xl text-balance text-sm leading-7 text-muted-foreground sm:text-base">
        Lexie runs as a single-agent chat surface here: persistent sessions, live tool traces,
        attachments, and OpenClaw controls without the old dataroom scaffolding.
      </p>

      <div className="mt-8 flex max-w-3xl flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((text) => (
          <Badge
            key={text}
            variant="outline"
            className="rounded-full border-primary/20 bg-card/80 px-4 py-2 text-xs font-normal text-foreground shadow-sm"
          >
            {text}
          </Badge>
        ))}
      </div>
    </div>
  );
}
