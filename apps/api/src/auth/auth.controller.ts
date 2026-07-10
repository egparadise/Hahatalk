import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Res, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import type { Response } from "express";
import { clearSessionCookie, setSessionCookie } from "./auth-cookie.js";
import { CurrentAuth, PublicRoute } from "./auth.decorators.js";
import { AuthService } from "./auth.service.js";
import type { AuthPrincipal } from "./auth.types.js";

class SignupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  displayName = "";

  @IsEmail()
  @MaxLength(254)
  email = "";

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password = "";

  @IsString()
  characterId = "char-calm-lead";

  @IsOptional()
  @IsString()
  inviteCode?: string;
}

class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email = "";

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password = "";
}

@Controller("auth")
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @PublicRoute()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post("signup")
  async signup(
    @Body() body: SignupDto,
    @Headers("user-agent") userAgent: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    const created = await this.authService.signup(body, userAgent);
    setSessionCookie(response, created.cookieToken);
    response.setHeader("Cache-Control", "no-store");
    return created.principal.state;
  }

  @PublicRoute()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post("login")
  async login(
    @Body() body: LoginDto,
    @Headers("user-agent") userAgent: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    const created = await this.authService.login(body, userAgent);
    setSessionCookie(response, created.cookieToken);
    response.setHeader("Cache-Control", "no-store");
    return created.principal.state;
  }

  @Get("me")
  me(@CurrentAuth() principal: AuthPrincipal, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store");
    return principal.state;
  }

  @Post("logout")
  async logout(@CurrentAuth() principal: AuthPrincipal, @Res({ passthrough: true }) response: Response) {
    await this.authService.logout(principal);
    clearSessionCookie(response);
    response.setHeader("Cache-Control", "no-store");
    return { ok: true };
  }

  @Get("sessions")
  sessions(@CurrentAuth() principal: AuthPrincipal, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store");
    return this.authService.listSessions(principal);
  }

  @Post("sessions/revoke-others")
  revokeOtherSessions(@CurrentAuth() principal: AuthPrincipal) {
    return this.authService.revokeOtherSessions(principal);
  }

  @Post("sessions/:sessionId/revoke")
  async revokeSession(
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @CurrentAuth() principal: AuthPrincipal,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.authService.revokeSession(principal, sessionId);
    if (result.current) {
      clearSessionCookie(response);
    }
    response.setHeader("Cache-Control", "no-store");
    return result;
  }
}
