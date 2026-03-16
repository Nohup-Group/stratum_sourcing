import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const backendTarget = process.env.LEXIE_NEW_URL || "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          "assistant-ui": [
            "@assistant-ui/react",
            "@assistant-ui/react-markdown",
          ],
          query: ["@tanstack/react-query"],
        },
      },
    },
  },
  server: {
    port: 5174,
    allowedHosts: [".railway.app", ".nohup.group"],
    proxy: {
      "/api/openclaw/ws": {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
        rewrite: () => "/",
      },
      "/api": {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: Number(process.env.PORT) || 4173,
    host: "0.0.0.0",
    allowedHosts: [".railway.app", ".nohup.group"],
  },
});
