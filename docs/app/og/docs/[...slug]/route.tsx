import { getPageImage, source } from '@/lib/source';
import { i18n } from '@/lib/i18n';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { generate as DefaultImage } from 'fumadocs-ui/og';
import { appName } from '@/lib/shared';

export const dynamic = 'force-static';
export const revalidate = false;

export async function GET(_req: Request, { params }: RouteContext<'/og/docs/[...slug]'>) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  return new ImageResponse(
    <DefaultImage title={page.data.title} description={page.data.description} site={appName} />,
    {
      width: 1200,
      height: 630,
    },
  );
}

export function generateStaticParams() {
  const unsupportedLocalePrefixes = new Set(['fa', 'ru', 'zh']);

  return source
    .getPages()
    .map((page) => ({ page, image: getPageImage(page) }))
    .filter(
      ({ page, image }) =>
        i18n.languages.includes(page.locale as (typeof i18n.languages)[number]) &&
        !unsupportedLocalePrefixes.has(image.segments[0]),
    )
    .map(({ page, image }) => ({
      lang: page.locale,
      slug: image.segments,
    }));
}
