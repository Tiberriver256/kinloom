import { asRevisionId, parseKinloomConfig, type RawPerson, toEntityPayload } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import { createKinloomServer } from './router.js';

function makeDynamicOgSiteConfig() {
  return parseKinloomConfig({
    schemaVersion: 1,
    site: {
      title: 'Alder Family Archive',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER_ARCHIVE',
      footerCredit: 'Built with Kinloom',
    },
    theme: { accent: '#2F5245' },
    brand: { dynamicOg: true },
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
    },
  });
}

describe('portable /privacy and /og/* routes on createKinloomServer', () => {
  const origin = 'https://archive.example.test';
  const sessionSecret = '0123456789abcdef0123456789abcdef';

  const deceased: RawPerson = {
    id: 'per_arthur_alder',
    slug: 'arthur-alder',
    full_name: 'Arthur Alder',
    given_name: 'Arthur',
    surname: 'Alder',
    alt_names: [],
    sex: 'M',
    birth_edtf: '1842',
    death_edtf: '1918',
    is_living: false,
    lineage_group: 'ancestor',
    branch: 'alder',
    has_primary_source: true,
    portrait_url: null,
    thumb_url: null,
  };

  const living: RawPerson = {
    id: 'per_jordan_alder',
    slug: 'jordan-alder',
    full_name: 'Jordan Alder',
    given_name: 'Jordan',
    surname: 'Alder',
    alt_names: [],
    sex: 'U',
    birth_edtf: '1990-06-15',
    death_edtf: '',
    is_living: true,
    lineage_group: 'descendant',
    branch: 'alder',
    has_primary_source: false,
    portrait_url: null,
    thumb_url: null,
  };

  it('serves GET and HEAD /privacy unauthenticated with security headers', async () => {
    const siteConfig = makeDynamicOgSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({ siteConfig, ports, sessionSecret, mode: 'private' });

    const res = await server.fetch(new Request(`${origin}/privacy`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    const html = await res.text();
    expect(html).toContain('<title>Privacy Policy | Alder Family Archive</title>');
    expect(html).toContain('zero advertisements');

    const headRes = await server.fetch(new Request(`${origin}/privacy/`, { method: 'HEAD' }));
    expect(headRes.status).toBe(200);
    expect(await headRes.text()).toBe('');
  });

  it('serves /og/site.svg and /og/person/:id.svg with strict living-person redaction', async () => {
    const siteConfig = makeDynamicOgSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    await ports.repository.commitAtomicMutations({
      batch_id: null,
      author: { author_id: 'seed', author_name: 'Seed', author_type: 'system_seed' },
      nowIso: ports.clock.nowIso(),
      operations: [
        {
          entity_type: 'person',
          entity_id: deceased.id,
          slug: deceased.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed deceased person',
          has_primary_source: true,
          before_json: null,
          after_json: toEntityPayload(deceased),
        },
        {
          entity_type: 'person',
          entity_id: living.id,
          slug: living.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed living person',
          has_primary_source: false,
          before_json: null,
          after_json: toEntityPayload(living),
        },
      ],
    });
    expect(await ports.repository.getHeadRevisionId()).toBe(asRevisionId(2));

    const server = createKinloomServer({ siteConfig, ports, sessionSecret, mode: 'private' });

    const siteOg = await server.fetch(new Request(`${origin}/og/site.svg`));
    expect(siteOg.status).toBe(200);
    expect(siteOg.headers.get('content-type')).toContain('image/svg+xml');
    expect(await siteOg.text()).toContain('Alder Family Archive');

    const deceasedOg = await server.fetch(new Request(`${origin}/og/person/${deceased.id}.svg`));
    expect(deceasedOg.status).toBe(200);
    const deceasedSvg = await deceasedOg.text();
    expect(deceasedSvg).toContain('Arthur Alder');
    expect(deceasedSvg).toContain('1842–1918');

    const livingOg = await server.fetch(new Request(`${origin}/og/person/${living.id}.svg`));
    expect(livingOg.status).toBe(200);
    const livingSvg = await livingOg.text();
    expect(livingSvg).toContain('Alder Family Archive');
    expect(livingSvg).not.toContain('Jordan');
    expect(livingSvg).not.toContain('1990');
  });
});
