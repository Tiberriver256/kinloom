import {
  formatDeceasedLifespan,
  type KinloomSiteConfig,
  type RawPerson,
  renderOgCardSvg,
  resolveBrandSpec,
  resolveRouteOgMetadata,
} from '@kinloom/core';
import { applySecurityHeaders } from '@kinloom/server';
import type { D1ArchiveRepository } from './adapters/d1Repository.js';

export interface DynamicOgRequestOptions {
  readonly pathname: string;
  readonly headOnly: boolean;
  readonly isSecure: boolean;
  readonly siteConfig: KinloomSiteConfig;
  readonly repository: Pick<D1ArchiveRepository, 'getEntity'>;
}

function buildSvgResponse(svg: string, headOnly: boolean, isSecure: boolean): Response {
  return applySecurityHeaders(
    new Response(headOnly ? null : svg, {
      status: 200,
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=3600',
        'referrer-policy': 'same-origin',
      },
    }),
    { isSecure }
  );
}

/**
 * Renders privacy-safe dynamic 1200x630 Open Graph SVG cards for:
 *   - GET /og/site.svg
 *   - GET /og/person/:id.svg (strictly falls back to site OG card if person is living or not found)
 *
 * Returns null if the pathname does not match an OG route.
 */
export async function handleDynamicOgRequest(options: DynamicOgRequestOptions): Promise<Response | null> {
  const { pathname, headOnly, isSecure, siteConfig, repository } = options;
  const spec = resolveBrandSpec(siteConfig);

  if (pathname === '/og/site.svg') {
    const svg = renderOgCardSvg({
      title: spec.title,
      subtitle: spec.subtitle,
      metadataLine: spec.metadataLine,
      footerCredit: spec.footerCredit,
      surface: spec.surface,
      accent: spec.accent,
    });
    return buildSvgResponse(svg, headOnly, isSecure);
  }

  const personMatch = pathname.match(/^\/og\/person\/([^/]+)\.svg$/);
  if (!personMatch) {
    return null;
  }

  let personId: string;
  try {
    personId = decodeURIComponent(personMatch[1]);
  } catch {
    personId = personMatch[1];
  }

  const entity = await repository.getEntity('person', personId);
  const person = entity && !entity.deleted_at && 'data' in entity ? (entity.data as RawPerson) : null;
  const ogMeta = resolveRouteOgMetadata({
    siteConfig,
    person,
  });

  // Living or missing people strictly render the generic site-level OG card
  if (!person || ogMeta.redacted) {
    const fallbackSvg = renderOgCardSvg({
      title: spec.title,
      subtitle: spec.subtitle,
      metadataLine: spec.metadataLine,
      footerCredit: spec.footerCredit,
      surface: spec.surface,
      accent: spec.accent,
    });
    return buildSvgResponse(fallbackSvg, headOnly, isSecure);
  }

  const lifespan = formatDeceasedLifespan(person);
  const svg = renderOgCardSvg({
    kicker: spec.title,
    title: person.full_name.trim() || 'Historical Person',
    subtitle: lifespan,
    metadataLine: spec.footerCredit ?? 'Built with Kinloom',
    footerCredit: spec.footerCredit,
    surface: spec.surface,
    accent: spec.accent,
  });
  return buildSvgResponse(svg, headOnly, isSecure);
}
