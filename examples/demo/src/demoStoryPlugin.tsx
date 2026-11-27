import type { KinloomUiPlugin } from '@kinloom/ui';
import {
  ArchivalBanner,
  ArchivalMediaGrid,
  ArchivalMetrics,
  ArchivalPageShell,
  ArchivalSection,
  ArchivalStoryCard,
  ExplorerTopBar,
  KINLOOM_UI_VERSION,
  KinloomFooter,
  MediaPlayer,
  useArchiveData,
} from '@kinloom/ui';
import type React from 'react';
import { Link } from 'react-router-dom';

const DemoReelStoryPage: React.FC = () => {
  const { bundle, siteConfig, baseUrl } = useArchiveData();
  const videoStories = (bundle?.media ?? []).filter((item) => item.kind === 'video_story');

  return (
    <div>
      <ExplorerTopBar />
      <ArchivalPageShell data-testid="demo-reel-page">
        <ArchivalBanner style={{ marginBottom: 18 }}>
          <div>
            <h1>Archival Story Reel</h1>
            <p>
              Curated historical story reel for the {siteConfig.site.familyName}, bringing together recorded
              family stories and archival vignettes.
            </p>
          </div>
          <ArchivalMetrics>
            <div>
              <strong>{bundle?.people.length ?? 0}</strong> documented individuals
            </div>
            <div>
              <strong>{videoStories.length}</strong> video stories
            </div>
          </ArchivalMetrics>
        </ArchivalBanner>

        {videoStories.length === 0 ? (
          <ArchivalSection>
            <h2>Featured Historical Vignette</h2>
            <p>
              Ten generations from Hingham, Norfolk (1622) to Springfield, Illinois and Manchester, Vermont
              (1985), grounded in primary census, patent, and vital records.
            </p>
          </ArchivalSection>
        ) : (
          <ArchivalSection>
            <h2>Uploaded Video Stories</h2>
            <ArchivalMediaGrid>
              {videoStories.map((item) => (
                <ArchivalStoryCard key={item.id}>
                  <MediaPlayer media={item} baseUrl={baseUrl} variant="full" />
                  <p style={{ marginTop: 8 }}>{item.caption}</p>
                </ArchivalStoryCard>
              ))}
            </ArchivalMediaGrid>
          </ArchivalSection>
        )}
      </ArchivalPageShell>
      <KinloomFooter />
    </div>
  );
};

export const demoStoryPlugin: KinloomUiPlugin = {
  id: 'demo-story-reel',
  name: 'Archival Story Reel',
  version: KINLOOM_UI_VERSION,
  status: 'active',
  routes: [
    {
      path: '/stories/demo-reel',
      navLabel: 'Stories',
      component: DemoReelStoryPage,
    },
  ],
  slots: {
    personDetail: ({ person }) => {
      if (!person) {
        return null;
      }
      return (
        <ArchivalSection
          data-testid="demo-plugin-person-slot"
          aria-label="Archival story highlight"
          style={{ marginBottom: 16 }}
        >
          <strong>Archival Story Spotlight:</strong> {person.full_name} is featured in the{' '}
          <Link to="/stories/demo-reel">Archival Story Reel</Link>.
        </ArchivalSection>
      );
    },
  },
};
