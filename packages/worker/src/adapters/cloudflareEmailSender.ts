import type { Clock, EmailSender } from '@kinloom/core';
import { bytesToStream, KinloomHttpError, randomBase64Url } from '@kinloom/server';
import type { SendEmailBinding, SendEmailMessage } from '../types.js';

export const DEFAULT_EMAIL_FROM = 'noreply@familyloom.org';

export interface CloudflareEmailSenderOptions {
  binding?: SendEmailBinding;
  fromEmail?: string;
  clock?: Clock;
  createMessage?: (from: string, to: string, rawMime: string) => SendEmailMessage;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function extractDomain(email: string): string {
  const atIdx = email.lastIndexOf('@');
  if (atIdx === -1) {
    return 'familyloom.org';
  }
  const domain = email.slice(atIdx + 1).trim();
  return domain || 'familyloom.org';
}

export function buildMagicLinkMimeMessage(params: {
  fromEmail: string;
  toEmail: string;
  siteTitle: string;
  magicLinkUrl: string;
  expiresMinutes: number;
  now?: Date;
}): string {
  const from = sanitizeHeaderValue(params.fromEmail);
  const to = sanitizeHeaderValue(params.toEmail);
  const siteTitle = sanitizeHeaderValue(params.siteTitle);
  const dateHeader = (params.now ?? new Date()).toUTCString();
  const messageId = `<kinloom-${randomBase64Url(12)}@${extractDomain(from)}>`;

  const bodyLines = [
    `Sign in to ${siteTitle}`,
    '',
    'Open this one-time link to sign in:',
    params.magicLinkUrl,
    '',
    `This link expires in ${params.expiresMinutes} minutes and can only be used once.`,
    'If you did not request this email, you can ignore it.',
  ];

  const headers = [
    `From: ${siteTitle} <${from}>`,
    `To: ${to}`,
    `Subject: Sign in to ${siteTitle}`,
    `Date: ${dateHeader}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];

  return `${headers.join('\r\n')}\r\n\r\n${bodyLines.join('\r\n')}\r\n`;
}

interface CloudflareEmailModule {
  EmailMessage?: new (
    from: string,
    to: string,
    raw: ReadableStream<Uint8Array> | string
  ) => SendEmailMessage;
}

async function createRuntimeEmailMessage(
  from: string,
  to: string,
  rawMime: string
): Promise<SendEmailMessage> {
  // Dynamically load cloudflare:email when running inside Cloudflare workerd; fall back to a plain object in Node/tests.
  const specifier = 'cloudflare:email';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as CloudflareEmailModule;
    if (typeof mod.EmailMessage === 'function') {
      return new mod.EmailMessage(from, to, rawMime);
    }
  } catch {
    // Running outside workerd (Node / Vitest)
  }
  const encoded = new TextEncoder().encode(rawMime);
  return {
    from,
    to,
    raw: bytesToStream(encoded),
  };
}

/**
 * Cloudflare SEND_EMAIL binding implementation of EmailSender.
 */
export class CloudflareEmailSender implements EmailSender {
  private readonly binding?: SendEmailBinding;
  private readonly fromEmail: string;
  private readonly clock?: Clock;
  private readonly createMessage?: (from: string, to: string, rawMime: string) => SendEmailMessage;

  constructor(options: CloudflareEmailSenderOptions = {}) {
    this.binding = options.binding;
    this.fromEmail = sanitizeHeaderValue(options.fromEmail ?? DEFAULT_EMAIL_FROM);
    this.clock = options.clock;
    this.createMessage = options.createMessage;
  }

  async sendMagicLink(params: {
    toEmail: string;
    siteTitle: string;
    magicLinkUrl: string;
    expiresMinutes: number;
  }): Promise<void> {
    if (!this.binding) {
      throw new KinloomHttpError(
        503,
        'EMAIL_SENDER_UNCONFIGURED',
        'Magic-link email delivery is not configured for this archive.'
      );
    }

    const toEmail = sanitizeHeaderValue(params.toEmail);
    const rawMime = buildMagicLinkMimeMessage({
      fromEmail: this.fromEmail,
      toEmail,
      siteTitle: params.siteTitle,
      magicLinkUrl: params.magicLinkUrl,
      expiresMinutes: params.expiresMinutes,
      now: this.clock?.now(),
    });

    const message = this.createMessage
      ? this.createMessage(this.fromEmail, toEmail, rawMime)
      : await createRuntimeEmailMessage(this.fromEmail, toEmail, rawMime);

    await this.binding.send(message);
  }
}
