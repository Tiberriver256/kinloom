import { z } from 'zod';
import type { AdminService } from '../../services/adminService.js';
import type { PluginSettingsService } from '../../services/pluginSettingsService.js';
import type { SystemDiagnosticsService } from '../../services/systemDiagnosticsService.js';
import { enforceCsrfOrigin, requireMinRole } from '../authMiddleware.js';
import { decodeSegment, type HttpRouteHandler, jsonResponse, readJsonBody } from '../httpPrimitives.js';
import { timeSpan } from '../pluginLifecycle.js';

const CreateInviteBodySchema = z.object({
  label: z.string(),
  expires_in_days: z.number().int().positive().optional(),
});

const CreateAgentTokenBodySchema = z.object({
  label: z.string(),
  scope: z.enum(['write_batch', 'read_backup']),
});

const CreateUserBodySchema = z.object({
  email: z.string(),
  display_name: z.string(),
  role: z.enum(['admin', 'editor']),
});

const UpdateUserBodySchema = z.object({
  role: z.enum(['admin', 'editor']),
  display_name: z.string().optional(),
});

export function createAdminRouteHandler(
  adminService: AdminService,
  systemDiagnosticsService?: SystemDiagnosticsService,
  pluginSettingsService?: PluginSettingsService
): HttpRouteHandler {
  return async (ctx) => {
    const { request, url, method, segments, auth, telemetry } = ctx;

    if (segments[0] !== 'api' || segments[1] !== 'admin') {
      return null;
    }

    enforceCsrfOrigin(request, url, auth.authMethod, telemetry);
    requireMinRole(auth.principal, 'admin', {
      adminForbiddenCode: 'ADMIN_REQUIRED',
      telemetry,
      bearerRejected: auth.bearerRejected,
    });
    const adminEmail = auth.principal.kind === 'user' ? auth.principal.email : 'admin';

    if (segments[2] === 'system' && method === 'GET' && segments.length === 3 && systemDiagnosticsService) {
      const report = await systemDiagnosticsService.getReport();
      return jsonResponse(report, 200);
    }

    if (segments[2] === 'plugin-settings' && pluginSettingsService) {
      if (method === 'GET' && segments.length === 3) {
        const plugins = await timeSpan(telemetry, 'd1', () => pluginSettingsService.listPluginSettings());
        return jsonResponse({ plugins }, 200);
      }
      if (method === 'PUT' && segments.length === 4) {
        const pluginId = decodeSegment(segments[3]);
        const rawPayload = await readJsonBody(request);
        const plugin = await timeSpan(telemetry, 'd1', () =>
          pluginSettingsService.updatePluginSettings({
            pluginId,
            rawPayload,
            updatedBy: adminEmail,
          })
        );
        return jsonResponse({ plugin }, 200);
      }
    }

    if (segments[2] === 'invites') {
      if (method === 'GET' && segments.length === 3) {
        const invites = await timeSpan(telemetry, 'd1', () => adminService.listInvites());
        return jsonResponse({ invites }, 200);
      }
      if (method === 'POST' && segments.length === 3) {
        const body = CreateInviteBodySchema.parse(await readJsonBody(request));
        const created = await timeSpan(telemetry, 'd1', () =>
          adminService.createInvite({
            label: body.label,
            expires_in_days: body.expires_in_days,
            createdBy: adminEmail,
            origin: url.origin,
          })
        );
        return jsonResponse(created, 201);
      }
      if (method === 'DELETE' && segments.length === 4) {
        await timeSpan(telemetry, 'd1', () =>
          adminService.revokeInvite({ token: decodeSegment(segments[3]) })
        );
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      }
    }

    if (segments[2] === 'agent-tokens') {
      if (method === 'GET' && segments.length === 3) {
        const tokens = await timeSpan(telemetry, 'd1', () => adminService.listAgentTokens());
        return jsonResponse({ tokens }, 200);
      }
      if (method === 'POST' && segments.length === 3) {
        const body = CreateAgentTokenBodySchema.parse(await readJsonBody(request));
        const created = await timeSpan(telemetry, 'd1', () =>
          adminService.createAgentToken({
            label: body.label,
            scope: body.scope,
            createdBy: adminEmail,
          })
        );
        return jsonResponse(created, 201);
      }
      if (method === 'DELETE' && segments.length === 4) {
        await timeSpan(telemetry, 'd1', () =>
          adminService.revokeAgentToken({ tokenId: decodeSegment(segments[3]) })
        );
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      }
    }

    if (segments[2] === 'users') {
      if (method === 'GET' && segments.length === 3) {
        const users = await timeSpan(telemetry, 'd1', () => adminService.listUsers());
        return jsonResponse({ users }, 200);
      }
      if (method === 'POST' && segments.length === 3) {
        const body = CreateUserBodySchema.parse(await readJsonBody(request));
        const user = await timeSpan(telemetry, 'd1', () =>
          adminService.createUser({
            email: body.email,
            display_name: body.display_name,
            role: body.role,
            addedBy: adminEmail,
          })
        );
        return jsonResponse({ user }, 201);
      }
      if (method === 'PATCH' && segments.length === 4) {
        const body = UpdateUserBodySchema.parse(await readJsonBody(request));
        const user = await timeSpan(telemetry, 'd1', () =>
          adminService.updateUser({
            email: decodeSegment(segments[3]),
            role: body.role,
            display_name: body.display_name,
          })
        );
        return jsonResponse({ user }, 200);
      }
      if (method === 'DELETE' && segments.length === 4) {
        await timeSpan(telemetry, 'd1', () => adminService.deleteUser({ email: decodeSegment(segments[3]) }));
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      }
    }

    return null;
  };
}
