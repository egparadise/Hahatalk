import { Body, Controller, Get, Headers, Post, Res } from "@nestjs/common";
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
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @PublicRoute()
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
}
