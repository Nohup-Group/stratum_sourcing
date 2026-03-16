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
      <div className="mb-6 inline-flex size-20 items-center justify-center rounded-[2rem] bg-[linear-gradient(145deg,#8758ff_0%,#4E00FF_60%,#2a0d74_100%)] p-4 shadow-[0_28px_60px_rgba(78,0,255,0.20)]">
        <img src="/logo-mark.svg" alt="Stratum mark" className="h-full w-full object-contain" />
      </div>

      <img
        src="/logo-lockup-light.svg"
        alt="Stratum"
        className="mb-4 h-14 w-auto dark:hidden"
      />
      <img
        src="/logo-lockup-dark.svg"
        alt="Stratum"
        className="mb-4 hidden h-14 w-auto dark:block"
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
