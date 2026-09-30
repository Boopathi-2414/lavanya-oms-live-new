import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// VitePWA removed - caused build errors with PNG icons on Vercel

export default defineConfig({
  plugins: [
    react(),
    // VitePWA removed to fix build errors
  ],
  // CHANGED: '/' instead of './' — relative paths break asset loading on Vercel
  base: '/',
  server: { port: 5173 },
  build: { outDir: 'dist' },
  optimizeDeps: {
    include: ['pdfjs-dist', 'xlsx']
  }
});
