export default function InviteGate() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="mx-auto flex max-w-md flex-col items-center text-center">
        <img
          src="/logo-lockup-light.png"
          alt="Stratum"
          className="mb-8 block h-auto w-[min(20rem,80vw)] dark:hidden"
        />
        <img
          src="/logo-lockup-dark.png"
          alt="Stratum"
          className="mb-8 hidden h-auto w-[min(20rem,80vw)] dark:block"
        />

        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Welcome to Lexie
        </h1>

        <p className="mt-3 text-sm text-muted-foreground">
          This is a private platform. Please use your invite link to access
          Lexie.
        </p>

        <p className="mt-6 text-xs text-muted-foreground/60">
          Stratum 3 Ventures
        </p>
      </div>
    </div>
  );
}
