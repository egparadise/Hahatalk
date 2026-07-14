import { ForbiddenException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";

export type OperationsRole = "admin" | "owner";

@Injectable()
export class OperationsContextService {
  constructor(private readonly database: DatabaseService) {}

  async run<TResult>(
    principal: AuthPrincipal,
    allowedRoles: readonly OperationsRole[],
    work: (client: PoolClient, organizationId: string) => Promise<TResult>
  ) {
    const organizationId = principal.state.user.organizationId;
    return this.database.transaction(async (client) => {
      await client.query("select set_config('hahatalk.organization_id', $1, true)", [organizationId]);
      await client.query("select set_config('hahatalk.actor_id', $1, true)", [principal.internalUserId]);
      const membership = await client.query<{ role: OperationsRole }>(
        `select role
         from organization_memberships
         where organization_id = $1 and user_id = $2 and status = 'active'`,
        [organizationId, principal.internalUserId]
      );
      const role = membership.rows[0]?.role;
      if (!role || !allowedRoles.includes(role)) {
        throw new ForbiddenException("Organization operations permission is required.");
      }
      return work(client, organizationId);
    });
  }

  async writeAudit(
    client: PoolClient,
    organizationId: string,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    metadata: Record<string, unknown> = {}
  ) {
    await client.query(
      `insert into audit_logs (
         organization_id, actor_id, action, target_type, target_id, metadata_json
       ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [organizationId, actorId, action, targetType, targetId, JSON.stringify(metadata)]
    );
  }
}
