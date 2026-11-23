import { describe, expect, it } from 'vitest';
import { documents } from './source';
import { documentMetadata, overviewMetadata } from './metadata';

describe('social metadata', () => {
  it('derives each localized card from its registry entry and canonical URL', () => {
    for (const doc of documents) {
      const metadata = documentMetadata(doc, 'https://example.com', '/framekit');
      const url = `https://example.com/framekit/${doc.locale}/docs/${doc.slug}/`;
      const image = `https://example.com/framekit/social/${doc.locale}/docs/${doc.slug}.png`;
      expect(metadata.openGraph).toMatchObject({ title: `${doc.title} | Framekit Docs`, description: doc.description, type: 'website', url, images: [{ url: image, width: 1200, height: 630, alt: doc.title }] });
      expect(metadata.twitter).toMatchObject({ card: 'summary_large_image', title: `${doc.title} | Framekit Docs`, description: doc.description, images: [image] });
    }
  });
  it('uses localized overview cards with absolute project URLs', () => {
    for (const locale of ['en', 'ja'] as const) {
      const metadata = overviewMetadata(locale, 'https://example.com', '/framekit');
      expect(metadata.openGraph).toMatchObject({ type: 'website', url: `https://example.com/framekit/${locale}/`, images: [{ url: `https://example.com/framekit/social/${locale}/overview.png` }] });
      expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' });
    }
  });
});
