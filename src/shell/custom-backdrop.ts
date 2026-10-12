// Custom backdrop image from public/custom/ (ignored by git).

const CANDIDATES = ['background.png', 'background.jpg', 'background.webp'];

/** URL of the first existing custom backdrop, or `undefined`. */
export async function findCustomBackdrop(): Promise<string | undefined> {
  for (const name of CANDIDATES) {
    const url = `/custom/${name}`;
    try {
      const response = await fetch(url, { method: 'HEAD' });
      // Vite returns index.html for unknown paths; so check the content type.
      if (response.ok && response.headers.get('content-type')?.startsWith('image/')) return url;
    } catch {
      // No custom backdrop; that is fine.
    }
  }
  return undefined;
}
