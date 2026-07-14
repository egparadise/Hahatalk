import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { publicRouteMetadataKey } from "./auth.decorators.js";
import { AuthService } from "./auth.service.js";
import { readSessionToken } from "./auth-cookie.js";
import type { AuthPrincipal } from "./auth.types.js";

type AuthenticatedRequest = Request & { auth?: AuthPrincipal };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService
  ) {}

  async canActivate(context: ExecutionContext) {
    if (context.getType() !== "http") {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(publicRouteMetadataKey, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const cookieToken = readSessionToken(request.headers.cookie);
    const principal = cookieToken
      ? await this.authService.authenticateToken(cookieToken)
      : await this.authService.authenticateBearerHeader(request.headers.authorization);
    if (!principal) {
      throw new UnauthorizedException("Authentication required.");
    }

    request.auth = principal;
    return true;
  }
}
