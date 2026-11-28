/**
 * Structural Cloudflare Workers binding interfaces compatible with both
 * Cloudflare's runtime (@cloudflare/workers-types) and local Miniflare without
 * conflicting with standard Web Fetch Request/Response types used in @kinloom/server.
 */

export interface D1Meta {
  changes?: number;
  last_row_id?: number;
  duration?: number;
  rows_read?: number;
  rows_written?: number;
  changed_db?: boolean;
}

export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  meta: D1Meta & Record<string, unknown>;
  results: T[];
  error?: string;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = unknown>(colName: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export type R2Range =
  | { offset: number; length?: number }
  | { offset?: number; length: number }
  | { suffix: number };

export interface R2GetOptions {
  range?: R2Range | Headers;
}

export interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
}

export interface R2PutOptions {
  onlyIf?: R2Conditional | Headers;
  httpMetadata?: R2HTTPMetadata | Headers;
  customMetadata?: Record<string, string>;
}

export interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
  readonly range?: R2Range;
}

export interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream<Uint8Array>;
  readonly bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: R2PutOptions
  ): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface Fetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface SendEmailAddress {
  email: string;
  name: string;
}

export interface SendEmailMessageBuilder {
  from: string | SendEmailAddress;
  to: string | SendEmailAddress | (string | SendEmailAddress)[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string | SendEmailAddress;
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  messageId: string;
}

export interface SendEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
}

export interface SendEmailBinding {
  send(message: SendEmailMessageBuilder): Promise<SendEmailResult | unknown>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface ExportedHandler<Env = unknown> {
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response>;
}

export interface KinloomWorkerEnv {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  ASSETS?: Fetcher;
  SEND_EMAIL?: SendEmailBinding;
  SESSION_SECRET: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  EMAIL_FROM?: string;
  ARCHIVE_MODE?: 'public' | 'private';
  GEMINI_API_KEY?: string;
  GEMINI_TTS_MODEL?: string;
  GOOGLE_CLOUD_TTS_API_KEY?: string;
  GCP_PROJECT_ID?: string;
  CHIRP3_HD_VOICE?: string;
  CF_WEB_ANALYTICS_TOKEN?: string;
  KINLOOM_BUILD_SHA?: string;
  KINLOOM_BUILD_TIMESTAMP?: string;
  KINLOOM_COMPATIBILITY_DATE?: string;
}
