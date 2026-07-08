import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    // Split the heavy visualization libraries out of the main bundle; with the
    // Map/Analytics tabs lazy-loaded in App.jsx, startup parses ~280 kB instead
    // of ~6 MB. Limit sits just above the biggest deliberate chunk (MapView,
    // ~3 MB — mostly the bundled 42k ZIP centroid table) so a genuinely new
    // bundling regression still trips the warning.
    chunkSizeWarningLimit: 3100,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          globe: ["react-globe.gl", "three"],
          charts: ["recharts"],
          leaflet: ["leaflet", "react-leaflet"],
          html2canvas: ["html2canvas"],
        },
      },
    },
  },
});
