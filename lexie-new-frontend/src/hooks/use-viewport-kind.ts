import { useEffect, useState } from "react";

export type ViewportKind = "phone" | "tablet" | "desktop";

function getViewportKind(width: number): ViewportKind {
  if (width < 768) return "phone";
  if (width < 1024) return "tablet";
  return "desktop";
}

export function useViewportKind(): ViewportKind {
  const [viewportKind, setViewportKind] = useState<ViewportKind>(() => {
    if (typeof window === "undefined") {
      return "desktop";
    }
    return getViewportKind(window.innerWidth);
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onResize = () => {
      setViewportKind(getViewportKind(window.innerWidth));
    };

    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return viewportKind;
}
