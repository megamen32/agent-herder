import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web-ui",
  plugins: [react()],
  build: { outDir: "../../dist/web-static", emptyOutDir: true },
});
