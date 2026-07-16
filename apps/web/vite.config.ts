import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/healthz": "http://127.0.0.1:3001",
      "/readyz": "http://127.0.0.1:3001",
      "/metrics": "http://127.0.0.1:3001",
      "/socket/canary": {
        target: "http://127.0.0.1:3002",
        ws: true,
      },
      "/socket.io": {
        target: "http://127.0.0.1:3001",
        ws: true,
      },
    },
  },
  build: {
    sourcemap: true,
  },
});
