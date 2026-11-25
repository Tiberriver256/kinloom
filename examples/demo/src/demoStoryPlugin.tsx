import type { KinloomUiPlugin } from '@kinloom/ui';
import { ExplorerTopBar, KinloomFooter, MediaPlayer, useArchiveData } from '@kinloom/ui';
import { Link } from 'react-router-dom';
import React from 'react';

const DemoReelStoryPage: React.FC = () => {
  const { bundle, siteConfig, baseUrl } = useArchiveData();
  const videoStories = (bundle?.media ?? []).filter((item) => item.kind === 'video_story');

  return (
    <div>
      <ExplorerTopBar />
      <main className="place-page" data-testid="demo-reel-page">
        <section className="wire-banner" style={{ marginBottom: 18 }}>
          <div>
            <h1>Archival Story Reel</h1>
            <p>
              Curated public-domain story reel plugin for {siteConfig.site.familyName}. Custom
              routes and detail slots mount cleanly through <code>KinloomUiPlugin</code>.
            </p>
          </div>
          <div className="folio-metrics">
            <div>
              <strong>{bundle?.people.length ?? 0}</strong> documented individuals
            </div>
            <div>
              <strong>{videoStories.length}</strong> video stories
            </div>
          </div>
        </section>

        {videoStories.length === 0 ? (
          <section className="place-map-box">
            <h2>Featured Historical Vignette</h2>
            <p>
              Ten generations from Hingham, Norfolk (1622) to Springfield, Illinois and Manchester,
              Vermont (1985), grounded in primary census, patent, and vital records.
            </p>
          </section>
        ) : (
          <section className="place-map-box">
            <h2>Uploaded Video Stories</h2>
            <div className="person-media-grid">
              {videoStories.map((item) => (
                <article key={item.id} className="story-card">
                  <MediaPlayer media={item} baseUrl={baseUrl} variant="full" />
                  <p style={{ marginTop: 8 }}>{item.caption}</p>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>
      <KinloomFooter />
    </div>
  );
};

export const demoStoryPlugin: KinloomUiPlugin = {
  id: 'demo-story-reel',
  name: 'Archival Story Reel',
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
        <section
          className="place-map-box"
          data-testid="demo-plugin-person-slot"
          aria-label="Archival story plugin highlight"
          style={{ marginBottom: 16 }}
        >
          <strong>Archival Story Spotlight:</strong> {person.full_name} is indexed in the{' '}
          <Link to="/stories/demo-reel">Archival Story Reel</Link>.
        </section>
      );
    },
  },
};
