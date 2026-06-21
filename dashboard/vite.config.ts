import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": "http://localhost:1930",
      "/v1": "http://localhost:1930",
      "/health": "http://localhost:1930",
    },
  },
});
