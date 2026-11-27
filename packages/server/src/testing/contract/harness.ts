import {
  type KinloomServerPorts,
  type KinloomSiteConfig,
  KinloomSiteConfigSchema,
  type RawEvent,
  type RawPerson,
} from '@kinloom/core';
import {
  FakeAuthProvider,
  type FakeOAuthProfile,
  InMemoryEmailSender,
  type SentMagicLinkEmail,
} from '../../adapters/inMemory.js';
import { FixedClock } from '../../adapters/systemClock.js';
import { createKinloomServer } from '../../http/router.js';
import { signSessionToken } from '../../http/session.js';

export const CONTRACT_TEST_ORIGIN = 'https://archive.example.test';
export const CONTRACT_SESSION_SECRET = 'kinloom-contract-suite-secret-key-2026-0123456789';

export function createSyntheticSiteConfig(): KinloomSiteConfig {
  return KinloomSiteConfigSchema.parse({
    schemaVersion: 1,
    site: {
      title: 'Alder Synthetic Family Archive',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER_SYNTHETIC',
      footerCredit: 'Built with Kinloom',
    },
    branches: [
      {
        id: 'alder',
        label: 'Alder Line',
        surnames: ['Alder'],
        lineageGroups: ['alder_core'],
      },
    ],
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
      privateModeShowsBirthYear: true,
      stripLivingPortraits: true,
      stripLivingResidenceSpans: true,
    },
    wiki: {
      allowTalk: true,
      allowWatchlists: false,
      maxUploadBytes: 15 * 1024 * 1024,
    },
  });
}

export function createSyntheticHistoricalPerson(overrides: Partial<RawPerson> = {}): RawPerson {
  return {
    id: 'per_arthur_alder',
    slug: 'arthur-alder',
    full_name: 'Arthur Alder',
    given_name: 'Arthur',
    surname: 'Alder',
    alt_names: [],
    sex: 'M',
    is_living: false,
    lineage_group: 'alder_core',
    birth_edtf: '1872-04-14',
    death_edtf: '1948-11-02',
    portrait_url: null,
    ...overrides,
  };
}

export function createSyntheticLivingPerson(overrides: Partial<RawPerson> = {}): RawPerson {
  return {
    id: 'per_clara_alder',
    slug: 'clara-alder',
    full_name: 'Clara Alder',
    given_name: 'Clara',
    surname: 'Alder',
    alt_names: [],
    sex: 'F',
    is_living: true,
    lineage_group: 'alder_core',
    birth_edtf: '1988-09-19',
    death_edtf: '',
    portrait_url: '/media/should-be-stripped.jpg',
    ...overrides,
  };
}

export function createSyntheticEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 'evt_homestead_1898',
    title: 'Homestead deed filed',
    scope: 'family',
    event_kind: 'point_event',
    edtf_date: '1898-06-12',
    place_id: null,
    summary: 'Arthur Alder recorded a homestead claim.',
    participants: [{ person_id: 'per_arthur_alder', role: 'principal' }],
    sources: [],
    ...overrides,
  };
}

export interface BackendAdapterContractHarness {
  siteConfig?: KinloomSiteConfig;
  ports: KinloomServerPorts;
  advanceClockMs?: (deltaMs: number) => void;
  getSentMagicLinks?: () => readonly SentMagicLinkEmail[];
  registerOAuthCode?: (code: string, profile: FakeOAuthProfile) => void;
  dispose?: () => Promise<void> | void;
}

export type BackendAdapterContractFactory = (
  siteConfig: KinloomSiteConfig
) => Promise<BackendAdapterContractHarness> | BackendAdapterContractHarness;

export interface ContractTestContext {
  siteConfig: KinloomSiteConfig;
  ports: KinloomServerPorts;
  server: ReturnType<typeof createKinloomServer>;
  advanceClockMs: (ms: number) => void;
  getSentMagicLinks: () => readonly SentMagicLinkEmail[];
  registerOAuthCode: (code: string, profile: FakeOAuthProfile) => void;
}

export type WithContractHarness = (fn: (ctx: ContractTestContext) => Promise<void>) => Promise<void>;

export function extractSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const combined = response.headers.get('set-cookie');
  return combined ? [combined] : [];
}

export function cookiePairFromSetCookie(setCookie: string): string {
  return setCookie.split(';')[0]?.trim() ?? '';
}

export async function seedAdminCookie(
  ports: KinloomServerPorts,
  email = 'admin@example.test',
  displayName = 'Archive Admin'
): Promise<string> {
  await ports.repository.upsertUser({
    email,
    display_name: displayName,
    role: 'admin',
    added_by: 'bootstrap',
    added_at: ports.clock.nowIso(),
    last_login_at: ports.clock.nowIso(),
  });
  const token = await signSessionToken({
    secret: CONTRACT_SESSION_SECRET,
    clock: ports.clock,
    ttlSeconds: 3600,
    payload: { kind: 'user', email, display_name: displayName, role: 'admin' },
  });
  return `__Host-kinloom_session=${token}`;
}

export function createContractHarnessRunner(
  createHarness: BackendAdapterContractFactory
): WithContractHarness {
  return async (fn) => {
    const defaultConfig = createSyntheticSiteConfig();
    const harness = await createHarness(defaultConfig);
    const siteConfig = harness.siteConfig ?? defaultConfig;
    const server = createKinloomServer({
      siteConfig,
      ports: harness.ports,
      sessionSecret: CONTRACT_SESSION_SECRET,
      bootstrapAdminEmail: 'bootstrap-admin@example.test',
    });

    const advanceClockMs =
      harness.advanceClockMs ??
      ((deltaMs: number) => {
        if (harness.ports.clock instanceof FixedClock) {
          harness.ports.clock.advanceMs(deltaMs);
        }
      });

    const getSentMagicLinks =
      harness.getSentMagicLinks ??
      (() => {
        if (harness.ports.emailSender instanceof InMemoryEmailSender) {
          return harness.ports.emailSender.sentMessages;
        }
        return [];
      });

    const registerOAuthCode =
      harness.registerOAuthCode ??
      ((code: string, profile: FakeOAuthProfile) => {
        if (harness.ports.authProvider instanceof FakeAuthProvider) {
          harness.ports.authProvider.registerCode(code, profile);
        }
      });

    try {
      await fn({
        siteConfig,
        ports: harness.ports,
        server,
        advanceClockMs,
        getSentMagicLinks,
        registerOAuthCode,
      });
    } finally {
      if (harness.dispose) {
        await harness.dispose();
      }
    }
  };
}
