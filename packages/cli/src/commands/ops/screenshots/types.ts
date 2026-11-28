export type ScreenshotCategory = 'page' | 'component' | 'plugin';

export type ScreenshotTheme = 'light' | 'dark';

export type ScreenshotStatus = 'captured' | 'skipped' | 'failed';

export type IncludeScope = 'pages' | 'components' | 'plugins';

export interface ViewportSpec {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export interface AuthHeader {
  readonly name: string;
  readonly value: string;
}

export type ComponentRecipeId =
  | 'topbar-default'
  | 'topbar-mobile-menu'
  | 'global-search-open'
  | 'global-search-results'
  | 'theme-toggle'
  | 'pronunciation-badge-default'
  | 'pronunciation-badge-variant'
  | 'source-reader-open'
  | 'media-lightbox-open'
  | 'tree-controls'
  | 'tree-focus-card'
  | 'map-controls'
  | 'map-stop-card'
  | 'auth-sign-in-modal'
  | 'narrative-audio-bar'
  | 'footer-default';

export interface PageCaptureTarget {
  readonly category: 'page';
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly route: string;
  readonly isMap?: boolean;
  readonly isHeavyPage?: boolean;
}

export interface ComponentCaptureTarget {
  readonly category: 'component';
  readonly id: string;
  readonly slug: string;
  readonly state: string;
  readonly label: string;
  readonly route: string;
  readonly recipeId: ComponentRecipeId;
  readonly viewportFilter?: readonly string[];
  readonly fullPage?: boolean;
}

export interface PluginCaptureTarget {
  readonly category: 'plugin';
  readonly id: string;
  readonly slug: string;
  readonly state: string;
  readonly label: string;
  readonly route: string;
  readonly pluginId?: string;
  readonly slotSelector?: string;
}

export type CaptureTarget = PageCaptureTarget | ComponentCaptureTarget | PluginCaptureTarget;

export interface DiscoveredPersonSample {
  readonly id: string;
  readonly slug: string;
  readonly fullName: string;
  readonly searchTerm: string;
  readonly hasPronunciation: boolean;
  readonly hasMedia: boolean;
  readonly hasBiography: boolean;
  readonly hasNarrativeAudio: boolean;
}

export interface DiscoveredPlaceSample {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface DiscoveredNarrativeSample {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
}

export interface BundleDiscoveryResult {
  readonly source: 'api-bundle' | 'static-bundle' | 'none';
  readonly people: readonly DiscoveredPersonSample[];
  readonly places: readonly DiscoveredPlaceSample[];
  readonly narratives: readonly DiscoveredNarrativeSample[];
}

export interface DiscoveredNavLink {
  readonly href: string;
  readonly text: string;
}

export interface DiscoveredPluginSlot {
  readonly pluginId: string;
  readonly slotName: string;
  readonly selector: string;
  readonly route: string;
}

export interface CaptureThemeAudit {
  readonly backgroundColor: string | null;
  readonly textColor: string | null;
  readonly backgroundLuminance: number | null;
  readonly contrastRatio: number | null;
  readonly isDarkSurface: boolean | null;
  readonly dataTheme: string | null;
  readonly prefersDark: boolean | null;
  readonly contentSha256?: string;
}

export type DarkThemeVerificationStatus =
  | 'not-requested'
  | 'verified'
  | 'partial-noop'
  | 'noop'
  | 'unverified';

export interface DarkThemeVerificationSummary {
  readonly status: DarkThemeVerificationStatus;
  readonly darkCaptureCount: number;
  readonly pairedCaptureCount: number;
  readonly distinctFromLightCount: number;
  readonly identicalToLightCount: number;
  readonly darkSurfaceVerifiedCount: number;
  readonly lightCanvasInDarkModeCount: number;
  readonly minDarkContrastRatio: number | null;
  readonly identicalCaptureIds: readonly string[];
}

export interface ManifestCaptureEntry {
  readonly category: ScreenshotCategory;
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly state: string;
  readonly route: string;
  readonly viewport: string;
  readonly theme: ScreenshotTheme;
  readonly file: string | null;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly status: ScreenshotStatus;
  readonly reason?: string;
  readonly fallbackUsed?: 'viewport-after-fullpage-timeout';
  readonly themeAudit?: CaptureThemeAudit;
  readonly consoleErrors: readonly string[];
  readonly failedRequests: readonly string[];
}

export interface ScreenshotsManifestSummary {
  readonly total: number;
  readonly captured: number;
  readonly skipped: number;
  readonly failed: number;
  readonly byCategory: Readonly<Record<ScreenshotCategory, number>>;
  readonly consoleErrorCount: number;
  readonly failedRequestCount: number;
}

export interface ScreenshotsManifest {
  readonly schemaVersion: 1;
  readonly targetUrl: string;
  readonly generatedAt: string;
  readonly viewports: readonly ViewportSpec[];
  readonly themes: readonly ScreenshotTheme[];
  readonly include: readonly IncludeScope[];
  readonly summary: ScreenshotsManifestSummary;
  readonly darkThemeVerification?: DarkThemeVerificationSummary;
  readonly captures: readonly ManifestCaptureEntry[];
}

export interface ScreenshotLocatorHandle {
  count(): Promise<number>;
  first(): ScreenshotLocatorHandle;
  nth(index: number): ScreenshotLocatorHandle;
  isVisible(): Promise<boolean>;
  isDisabled?(): Promise<boolean>;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  screenshot(options: {
    path: string;
    timeout?: number;
    animations?: 'disabled' | 'allow';
  }): Promise<unknown>;
  boundingBox(): Promise<{ width: number; height: number } | null>;
  textContent(): Promise<string | null>;
}

export interface ScreenshotPageHandle {
  goto(
    url: string,
    options?: { waitUntil?: 'load' | 'domcontentloaded' | 'commit'; timeout?: number }
  ): Promise<unknown>;
  emulateMedia?(options: { readonly colorScheme?: ScreenshotTheme | 'no-preference' | null }): Promise<void>;
  screenshot(options: {
    path: string;
    fullPage?: boolean;
    timeout?: number;
    animations?: 'disabled' | 'allow';
  }): Promise<unknown>;
  locator(selector: string): ScreenshotLocatorHandle;
  evaluate<T>(pageFunction: string): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(
    selector: string,
    options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }
  ): Promise<unknown>;
  keyboard: {
    press(key: string): Promise<void>;
  };
  on(event: 'console', listener: (msg: { type(): string; text(): string }) => void): void;
  on(event: 'pageerror', listener: (err: Error) => void): void;
  on(
    event: 'requestfailed',
    listener: (req: { url(): string; failure(): { errorText?: string } | null }) => void
  ): void;
  close(): Promise<void>;
  setDefaultTimeout?(timeout: number): void;
  setDefaultNavigationTimeout?(timeout: number): void;
}

export interface ScreenshotCookieSpec {
  readonly name: string;
  readonly value: string;
  readonly url: string;
}

export interface ScreenshotContextOptions {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly colorScheme: ScreenshotTheme;
  readonly extraHTTPHeaders?: Readonly<Record<string, string>>;
}

export interface ScreenshotContextHandle {
  addCookies?(cookies: readonly ScreenshotCookieSpec[]): Promise<void>;
  newPage(): Promise<ScreenshotPageHandle>;
  close(): Promise<void>;
  setDefaultTimeout?(timeout: number): void;
  setDefaultNavigationTimeout?(timeout: number): void;
}

export interface ScreenshotBrowserHandle {
  newContext(options: ScreenshotContextOptions): Promise<ScreenshotContextHandle>;
  close(): Promise<void>;
}

export type ScreenshotBrowserFactory = (options: {
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
}) => Promise<ScreenshotBrowserHandle>;

export interface ScreenshotsCommandOptions {
  readonly url: string;
  readonly outDir?: string;
  readonly viewports?: readonly ViewportSpec[];
  readonly themes?: readonly ScreenshotTheme[];
  readonly include?: readonly IncludeScope[];
  readonly routes?: readonly string[];
  readonly pluginRoutes?: readonly string[];
  readonly samplePeople?: number;
  readonly samplePlaces?: number;
  readonly authCookie?: string;
  readonly authHeaders?: readonly AuthHeader[];
  readonly fullPage?: boolean;
  readonly waitMs?: number;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  readonly json?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly browserFactory?: ScreenshotBrowserFactory;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ScreenshotsCommandResult {
  readonly ok: boolean;
  readonly outDir: string;
  readonly manifestPath: string;
  readonly indexHtmlPath: string;
  readonly manifest: ScreenshotsManifest;
  readonly rendered: string;
}
