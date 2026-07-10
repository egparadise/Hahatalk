import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { AuthPrincipal } from "./auth.types.js";

export const publicRouteMetadataKey = "hahatalk:public-route";
export const PublicRoute = () => SetMetadata(publicRouteMetadataKey, true);

export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AuthPrincipal => {
  const request = context.switchToHttp().getRequest<{ auth: AuthPrincipal }>();
  return request.auth;
});
