import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  // relative asset paths, so the built app runs from any subdirectory of a
  // web server rather than only from the document root
  base: './',
  plugins: [svelte()],
})
