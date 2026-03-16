import { Moon, Sun } from "lucide-react";
import { useDarkMode } from "@/hooks/use-dark-mode";
import { Button } from "@/components/ui/button";

export default function ThemeToggle() {
  const { isDark, toggle } = useDarkMode();

  return (
    <Button
      variant="ghost"
      className="w-full justify-start gap-2.5 text-muted-foreground"
      onClick={toggle}
    >
      {isDark ? <Sun size={15} /> : <Moon size={15} />}
      <span className="text-xs">{isDark ? "Light Mode" : "Dark Mode"}</span>
    </Button>
  );
}
