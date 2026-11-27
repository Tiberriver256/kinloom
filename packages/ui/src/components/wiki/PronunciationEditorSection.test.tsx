/** @vitest-environment jsdom */
import type { Pronunciation } from '@kinloom/core';
import type React from 'react';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PronunciationEditorSection } from './PronunciationEditorSection.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function setNativeInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderIntoDom(element: React.ReactElement): {
  container: HTMLDivElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PronunciationEditorSection', () => {
  it('renders segmented given/middle/surname token chips, edits any token via PUT /api/pronunciations/:term, and shows inline IPA hints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/pronunciations/Anderson' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Pronunciation;
        return new Response(
          JSON.stringify({
            term: 'Anderson',
            pronunciation: body,
            pronunciations: {
              Daniel: {
                phonetic: 'DAN-yuhl',
                ipa: '/ˈdæn.jəl/',
                language: 'en-US',
                source_label: 'Wiktionary',
                source_url: 'https://en.wiktionary.org/wiki/Daniel',
              },
              Anderson: body,
              Alder: {
                phonetic: 'AWL-der',
                ipa: '/ˈɔːl.dər/',
                language: 'en-US',
                source_label: 'Wiktionary',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // biome-ignore lint/correctness/noComponentHookFactories: isolated test harness
    const Harness: React.FC = () => {
      const [pronunciations, setPronunciations] = useState<Record<string, Pronunciation>>({
        Daniel: {
          phonetic: 'DAN-yuhl',
          ipa: '/ˈdæn.jəl/',
          language: 'en-US',
          source_label: 'Wiktionary',
          source_url: 'https://en.wiktionary.org/wiki/Daniel',
        },
        Alder: {
          phonetic: 'AWL-der',
          ipa: '/ˈɔːl.dər/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      });
      const [draftPron, setDraftPron] = useState<Pronunciation | null>(null);

      return (
        <PronunciationEditorSection
          entityType="person"
          entityId="per_daniel_alder"
          fullName="Daniel Anderson Alder"
          givenName="Daniel Anderson"
          surname="Alder"
          placeName=""
          previewLabel="Daniel Anderson Alder"
          draftPronunciation={draftPron}
          pronunciations={pronunciations}
          isBusy={false}
          onUpdatePronunciation={setDraftPron}
          onSetPronunciations={setPronunciations}
        />
      );
    };

    const { container, unmount } = renderIntoDom(<Harness />);

    const danielChip = container.querySelector<HTMLButtonElement>(
      'button[data-pronunciation-token="Daniel"]'
    );
    const andersonChip = container.querySelector<HTMLButtonElement>(
      'button[data-pronunciation-token="Anderson"]'
    );
    const alderChip = container.querySelector<HTMLButtonElement>('button[data-pronunciation-token="Alder"]');

    expect(danielChip).not.toBeNull();
    expect(andersonChip).not.toBeNull();
    expect(alderChip).not.toBeNull();
    expect(danielChip!.textContent).toContain('DAN-yuhl');
    expect(andersonChip!.textContent).toContain('Not set');
    expect(alderChip!.textContent).toContain('AWL-der');

    // Source link renders alongside the chip button rather than nested inside <button>
    expect(danielChip!.querySelector('a')).toBeNull();
    const sourceLink = container.querySelector<HTMLAnchorElement>(
      'a[href="https://en.wiktionary.org/wiki/Daniel"]'
    );
    expect(sourceLink).not.toBeNull();

    // Open inline editor for the middle name token "Anderson"
    act(() => {
      andersonChip!.click();
    });
    expect(container.textContent).toContain('Shared pronunciation for “Anderson”');

    const sharedEditor = container.querySelector('.wiki-pronunciation-shared-editor')!;
    const sharedPhonetic = sharedEditor.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. DAN-yuhl or MER-ser"]'
    )!;
    const sharedIpa = sharedEditor.querySelector<HTMLInputElement>('input[placeholder="e.g. /ˈdæn.jəl/"]')!;

    // Entering IPA glyphs in Respelling shows non-blocking inline hint
    act(() => {
      setNativeInputValue(sharedPhonetic, 'AN-dər-sən');
    });
    expect(sharedEditor.textContent).toContain('Found IPA symbol (ə)');
    expect(sharedEditor.textContent).toContain('plain English syllables');

    // Switching to plain English clears the hint
    act(() => {
      setNativeInputValue(sharedPhonetic, 'AN-der-sun');
      setNativeInputValue(sharedIpa, '/ˈæn.dər.sən/');
    });
    expect(sharedEditor.textContent).not.toContain('Found IPA symbol');

    const saveBtn = Array.from(sharedEditor.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save for all Anderson records'
    )!;
    await act(async () => {
      saveBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pronunciations/Anderson',
      expect.objectContaining({ method: 'PUT', credentials: 'include' })
    );

    // Live composed preview appears and Personal override collapses neatly behind toggle
    expect(container.querySelector('[data-testid="pronunciation-composed-preview"]')?.textContent).toContain(
      'DAN-yuhl AN-der-sun AWL-der'
    );
    expect(container.textContent).toContain('Customize for this person only');
    expect(container.querySelector('input[placeholder="e.g. MER-ser or LAY-den"]')).toBeNull();

    unmount();
  });

  it('collapses personal override when all shared tokens resolve, clears explicit override cleanly, and shows personal IPA hint', () => {
    const updatedValues: Array<Pronunciation | null> = [];

    // biome-ignore lint/correctness/noComponentHookFactories: isolated test harness
    const Harness: React.FC<{ initialOverride: Pronunciation | null }> = ({ initialOverride }) => {
      const [draftPron, setDraftPron] = useState<Pronunciation | null>(initialOverride);
      return (
        <PronunciationEditorSection
          entityType="person"
          entityId="per_daniel_alder"
          fullName="Daniel Anderson Alder"
          givenName="Daniel Anderson"
          surname="Alder"
          placeName=""
          previewLabel="Daniel Anderson Alder"
          draftPronunciation={draftPron}
          pronunciations={{
            Daniel: { phonetic: 'DAN-yuhl', ipa: '/ˈdæn.jəl/', language: 'en-US' },
            Anderson: { phonetic: 'AN-der-sun', ipa: '/ˈæn.dər.sən/', language: 'en-US' },
            Alder: { phonetic: 'AWL-der', ipa: '/ˈɔːl.dər/', language: 'en-US' },
          }}
          isBusy={false}
          onUpdatePronunciation={(next) => {
            updatedValues.push(next);
            setDraftPron(next);
          }}
          onSetPronunciations={() => {}}
        />
      );
    };

    // 1. Existing redundant personal override shows "Use shared names (clear personal override)"
    const withOverride = renderIntoDom(
      <Harness
        initialOverride={{
          phonetic: 'DAN-yuhl AN-der-sun AWL-der',
          ipa: '/ˈdæn.jəl ˈæn.dər.sən ˈɔːl.dər/',
        }}
      />
    );
    const clearBtn = Array.from(withOverride.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Use shared names (clear personal override)')
    );
    expect(clearBtn).toBeDefined();

    // Typing IPA in personal override Respelling triggers inline hint
    const personalInput = withOverride.container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. MER-ser or LAY-den"]'
    )!;
    act(() => {
      setNativeInputValue(personalInput, '/ˈdæn.jəl/');
    });
    expect(withOverride.container.textContent).toContain('Found IPA symbol');

    // Clicking clear sets draft pronunciation to null and collapses personal override
    act(() => {
      clearBtn!.click();
    });
    expect(updatedValues.at(-1)).toBeNull();
    expect(withOverride.container.textContent).toContain('Personal override cleared');
    expect(withOverride.container.querySelector('input[placeholder="e.g. MER-ser or LAY-den"]')).toBeNull();

    // Clicking "Customize for this person only" expands the override fields again
    const expandBtn = Array.from(withOverride.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Customize for this person only')
    )!;
    act(() => {
      expandBtn.click();
    });
    expect(
      withOverride.container.querySelector('input[placeholder="e.g. MER-ser or LAY-den"]')
    ).not.toBeNull();

    withOverride.unmount();
  });
});
