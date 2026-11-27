import { parseKinloomConfig, type RawPerson } from '@kinloom/core';
import { handleDynamicOgRequest } from '@kinloom/server';
import { describe, expect, it } from 'vitest';

function makeSiteConfig() {
  return parseKinloomConfig({
    schemaVersion: 1,
    site: {
      title: 'Alder Family Archive',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER_ARCHIVE',
      footerCredit: 'Built with Kinloom',
    },
    theme: { accent: '#2F5245' },
    brand: {
      dynamicOg: true,
    },
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
    },
  });
}

describe('worker dynamic OG SVG handler', () => {
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

  const mockRepo = {
    async getEntity(_type: string, id: string) {
      if (id === deceased.id) {
        return { data: deceased, deleted_at: null } as never;
      }
      if (id === living.id) {
        return { data: living, deleted_at: null } as never;
      }
      return null;
    },
  };

  it('renders site OG SVG for /og/site.svg', async () => {
    const res = await handleDynamicOgRequest({
      pathname: '/og/site.svg',
      headOnly: false,
      isSecure: true,
      siteConfig: makeSiteConfig(),
      repository: mockRepo,
    });
    expect(res).not.toBeNull();
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('image/svg+xml');
    const body = await res?.text();
    expect(body).toContain('Alder Family Archive');
    expect(body).toContain('viewBox="0 0 1200 630"');
  });

  it('renders deceased ancestor card for /og/person/:id.svg', async () => {
    const res = await handleDynamicOgRequest({
      pathname: '/og/person/per_arthur_alder.svg',
      headOnly: false,
      isSecure: true,
      siteConfig: makeSiteConfig(),
      repository: mockRepo,
    });
    expect(res?.status).toBe(200);
    const body = await res?.text();
    expect(body).toContain('Arthur Alder');
    expect(body).toContain('1842–1918');
  });

  it('strictly redacts living person OG card and falls back to generic site card', async () => {
    const res = await handleDynamicOgRequest({
      pathname: '/og/person/per_jordan_alder.svg',
      headOnly: false,
      isSecure: true,
      siteConfig: makeSiteConfig(),
      repository: mockRepo,
    });
    expect(res?.status).toBe(200);
    const body = await res?.text();
    expect(body).toContain('Alder Family Archive');
    expect(body).not.toContain('Jordan');
    expect(body).not.toContain('1990');
  });
});
