import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Oravan',
    short_name: 'Oravan',
    // Neutral pre-launch description; the S4 voice pass owns the final line
    // (hero decision M5 pending).
    description: 'Make your voice heard. One call at a time.',
    start_url: '/',
    display: 'standalone',
    background_color: '#F3ECDD', // paper
    theme_color: '#2A2318', // ink
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
