// Eigen achtergrondafbeelding uit public/custom/ (genegeerd door git).

const CANDIDATES = ['background.png', 'background.jpg', 'background.webp'];

/** URL van de eerste eigen achtergrond die bestaat, of `undefined`. */
export async function findCustomBackdrop(): Promise<string | undefined> {
  for (const name of CANDIDATES) {
    const url = `/custom/${name}`;
    try {
      const response = await fetch(url, { method: 'HEAD' });
      // Vite geeft voor onbekende paden index.html terug; controleer daarom het type.
      if (response.ok && response.headers.get('content-type')?.startsWith('image/')) return url;
    } catch {
      // Geen eigen achtergrond; dat is prima.
    }
  }
  return undefined;
}
