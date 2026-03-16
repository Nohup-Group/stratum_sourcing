import { Badge } from "@/components/ui/badge";

const SUGGESTIONS = [
  "Summarize the latest themes from recent notes",
  "Draft a sharp outreach message for a new contact",
  "Compare three options and recommend the best next step",
  "Turn rough notes into a clean memo outline",
];

export default function WelcomeContent() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-12 text-center sm:py-20">
      <img
        src="/logo-lockup-light.png"
        alt="Stratum"
        className="mb-6 block h-auto w-[min(24rem,82vw)] dark:hidden"
      />
      <img
        src="/logo-lockup-dark.png"
        alt="Stratum"
        className="mb-6 hidden h-auto w-[min(24rem,82vw)] dark:block"
      />

      <h1 className="max-w-2xl text-balance text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-5xl">
        Chat with Lexie.
      </h1>

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
