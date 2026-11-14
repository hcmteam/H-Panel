import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

// Required for `output: 'export'` — the search index is fully static.
export const revalidate = false;
export const dynamic = 'force-static';

// The docs currently configure English as the only supported locale.
export const { staticGET: GET } = createFromSource(source, {
  localeMap: {
    en: 'english',
  },
});
