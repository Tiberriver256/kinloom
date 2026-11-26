import type { Clock, EmailSender } from '@kinloom/core';
import { KinloomHttpError, randomBase64Url } from '@kinloom/server';
import type { SendEmailBinding, SendEmailMessageBuilder } from '../types.js';

export const DEFAULT_EMAIL_FROM = 'noreply@familyloom.org';

export interface CloudflareEmailSenderOptions {
  binding?: SendEmailBinding;
  fromEmail?: string;
  clock?: Clock;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractDomain(email: string): string {
  const atIdx = email.lastIndexOf('@');
  if (atIdx === -1) {
    return 'familyloom.org';
  }
  const domain = email.slice(atIdx + 1).trim();
  return domain || 'familyloom.org';
}

export function buildMagicLinkEmailMessage(params: {
  fromEmail: string;
  toEmail: string;
  siteTitle: string;
  magicLinkUrl: string;
  expiresMinutes: number;
}): SendEmailMessageBuilder {
  const from = sanitizeHeaderValue(params.fromEmail);
  const to = sanitizeHeaderValue(params.toEmail);
  const siteTitle = sanitizeHeaderValue(params.siteTitle) || 'Kinloom';
  const subject = `Sign in to ${siteTitle}`;

  const text = [
    `Sign in to ${siteTitle}`,
    '',
    'Open this one-time link to sign in:',
    params.magicLinkUrl,
    '',
    `This link expires in ${params.expiresMinutes} minutes and can only be used once.`,
    'If you did not request this email, you can ignore it.',
  ].join('\n');

  const safeTitle = escapeHtml(siteTitle);
  const safeUrl = escapeHtml(params.magicLinkUrl);
  const html = [
    '<!doctype html>',
    '<html>',
    '<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif; color: #1c1917; line-height: 1.5; max-width: 560px; margin: 0 auto; padding: 24px;">',
    `  <h1 style="font-size: 20px; margin: 0 0 16px;">Sign in to ${safeTitle}</h1>`,
    '  <p style="margin: 0 0 20px;">Open this one-time link to sign in:</p>',
    `  <p style="margin: 0 0 24px;"><a href="${safeUrl}" style="display: inline-block; background-color: #1c1917; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 6px; font-weight: 600;">Sign in to ${safeTitle}</a></p>`,
    `  <p style="margin: 0 0 16px; font-size: 13px; color: #57534e; word-break: break-all;">Or copy and paste this link into your browser:<br>${safeUrl}</p>`,
    `  <p style="margin: 0 0 8px; font-size: 13px; color: #57534e;">This link expires in ${params.expiresMinutes} minutes and can only be used once.</p>`,
    '  <p style="margin: 0; font-size: 13px; color: #57534e;">If you did not request this email, you can ignore it.</p>',
    '</body>',
    '</html>',
  ].join('\n');

  return {
    from: { email: from, name: siteTitle },
    to,
    subject,
    text,
    html,
  };
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

function formatDeliveryErrorDetail(error: unknown, magicLinkUrl: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return magicLinkUrl ? raw.split(magicLinkUrl).join('[redacted]') : raw;
}

// Cloudflare Email Service rejects these recipients before delivery. On the Workers Free plan,
// E_RECIPIENT_PLAN_RESTRICTED means only verified destination addresses can receive mail.
const RECIPIENT_REJECTION_CODES = new Set([
  'E_RECIPIENT_PLAN_RESTRICTED',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
]);

function readErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' && code ? code : null;
}

/**
 * Cloudflare SEND_EMAIL binding implementation of EmailSender.
 * Uses Cloudflare Email Service's native structured EmailMessageBuilder payload.
 */
export class CloudflareEmailSender implements EmailSender {
  private readonly binding?: SendEmailBinding;
  private readonly fromEmail: string;

  constructor(options: CloudflareEmailSenderOptions = {}) {
    this.binding = options.binding;
    this.fromEmail = sanitizeHeaderValue(options.fromEmail ?? DEFAULT_EMAIL_FROM);
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

    const message = buildMagicLinkEmailMessage({
      fromEmail: this.fromEmail,
      toEmail: params.toEmail,
      siteTitle: params.siteTitle,
      magicLinkUrl: params.magicLinkUrl,
      expiresMinutes: params.expiresMinutes,
    });

    try {
      await this.binding.send(message);
    } catch (error) {
      if (error instanceof KinloomHttpError) {
        throw error;
      }
      const detail = formatDeliveryErrorDetail(error, params.magicLinkUrl);
      const code = readErrorCode(error);
      console.error(
        `[kinloom/worker] SEND_EMAIL binding delivery failed (${code ?? 'no code'}): ${detail}`
      );
      if (code && RECIPIENT_REJECTION_CODES.has(code)) {
        throw new KinloomHttpError(
          502,
          'EMAIL_RECIPIENT_NOT_ALLOWED',
          'This archive cannot send sign-in email to that address yet. Ask the archive owner for help.'
        );
      }
      throw new KinloomHttpError(
        502,
        'EMAIL_DELIVERY_FAILED',
        'Unable to send sign-in email right now. Please try again later.'
      );
    }
  }
}
