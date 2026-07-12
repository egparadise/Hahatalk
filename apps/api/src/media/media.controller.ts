import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res
} from "@nestjs/common";
import type {
  AudienceType,
  InitiateMediaUploadInput,
  MediaArchiveScope,
  MediaUploadSource,
  MemberRole,
  ShareMediaAssetInput
} from "@hahatalk/contracts";
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";
import type { Request, Response } from "express";
import { CurrentAuth } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { MediaService } from "./media.service.js";

class InitiateUploadDto implements InitiateMediaUploadInput {
  @IsString()
  @MinLength(8)
  @MaxLength(160)
  clientUploadId = "";

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName = "";

  @IsString()
  @MinLength(3)
  @MaxLength(160)
  declaredMimeType = "application/octet-stream";

  @IsInt()
  @Min(1)
  @Max(104_857_600)
  sizeBytes = 0;

  @IsOptional()
  @Matches(/^[0-9a-fA-F]{64}$/)
  sha256Hex?: string;

  @IsIn(["file_upload", "screen_capture"])
  source: MediaUploadSource = "file_upload";
}

class CompleteUploadDto {
  @IsOptional()
  @Matches(/^[0-9a-fA-F]{64}$/)
  sha256Hex?: string;
}

class ShareAssetDto implements ShareMediaAssetInput {
  @IsUUID()
  spaceId = "";

  @IsString()
  @MinLength(8)
  @MaxLength(160)
  clientMessageId = "";

  @IsIn(["all", "selected", "private", "role"])
  audienceType: AudienceType = "all";

  @IsArray()
  @IsString({ each: true })
  targetUserIds: string[] = [];

  @IsOptional()
  @IsIn(["owner", "admin", "member", "guest", "subscriber"])
  targetRole?: MemberRole;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  caption?: string;

  @IsIn(["shared", "selected"])
  archiveScope: "shared" | "selected" = "shared";
}

class UpdateAssetMetadataDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  placeName?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/)
  capturedLocalAt?: string;
}

class CreateAlbumDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name = "";

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

class AlbumItemDto {
  @IsUUID()
  assetId = "";
}

@Controller("media")
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post("uploads")
  initiateUpload(@Body() body: InitiateUploadDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.media.initiateUpload(principal, body);
  }

  @Get("uploads/:uploadId")
  uploadView(
    @Param("uploadId", ParseUUIDPipe) uploadId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.uploadView(principal, uploadId);
  }

  @Put("uploads/:uploadId/parts/:partNumber")
  uploadPart(
    @Param("uploadId", ParseUUIDPipe) uploadId: string,
    @Param("partNumber", ParseIntPipe) partNumber: number,
    @Req() request: Request,
    @Headers("x-hahatalk-part-sha256") partSha256: string | undefined,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.uploadPart(principal, uploadId, partNumber, request, partSha256);
  }

  @Post("uploads/:uploadId/complete")
  completeUpload(
    @Param("uploadId", ParseUUIDPipe) uploadId: string,
    @Body() body: CompleteUploadDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.completeUpload(principal, uploadId, body.sha256Hex);
  }

  @Delete("uploads/:uploadId")
  abortUpload(
    @Param("uploadId", ParseUUIDPipe) uploadId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.abortUpload(principal, uploadId);
  }

  @Get("library")
  listLibrary(
    @CurrentAuth() principal: AuthPrincipal,
    @Query("before") before?: string,
    @Query("date") date?: string,
    @Query("place") place?: string,
    @Query("scope") scope?: MediaArchiveScope,
    @Query("limit") rawLimit?: string
  ) {
    if (scope && !["private_archive", "shared", "selected"].includes(scope)) {
      throw new BadRequestException("Media scope is invalid.");
    }
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw new BadRequestException("Media page limit must be between 1 and 100.");
    }
    return this.media.listLibrary(principal, {
      ...(before ? { before } : {}),
      ...(date ? { date } : {}),
      ...(place ? { place } : {}),
      ...(scope ? { scope } : {}),
      ...(limit !== undefined ? { limit } : {})
    });
  }

  @Get("assets/:assetId")
  getAsset(
    @Param("assetId", ParseUUIDPipe) assetId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.getAsset(principal, assetId);
  }

  @Patch("assets/:assetId")
  updateAsset(
    @Param("assetId", ParseUUIDPipe) assetId: string,
    @Body() body: UpdateAssetMetadataDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.updateAssetMetadata(principal, assetId, body.placeName, body.capturedLocalAt);
  }

  @Post("assets/:assetId/share")
  shareAsset(
    @Param("assetId", ParseUUIDPipe) assetId: string,
    @Body() body: ShareAssetDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.shareAsset(principal, assetId, body);
  }

  @Delete("assets/:assetId/shares/:messageId")
  revokeShare(
    @Param("assetId", ParseUUIDPipe) assetId: string,
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.revokeShare(principal, assetId, messageId);
  }

  @Delete("assets/:assetId")
  trashAsset(
    @Param("assetId", ParseUUIDPipe) assetId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.trashAsset(principal, assetId);
  }

  @Post("assets/:assetId/restore")
  restoreAsset(
    @Param("assetId", ParseUUIDPipe) assetId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.restoreAsset(principal, assetId);
  }

  @Get("assets/:assetId/content")
  async content(
    @Param("assetId", ParseUUIDPipe) assetId: string,
    @Query("variant") rawVariant: string | undefined,
    @Query("download") rawDownload: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    const variant = rawVariant === "original" ? "original" : rawVariant === "preview" || rawVariant === undefined ? "preview" : undefined;
    if (!variant) throw new BadRequestException("Media variant is invalid.");
    const download = rawDownload === "1";
    const content = await this.media.openContent(principal, assetId, variant, request.headers.range, download);
    const contentLength = content.range
      ? content.range.end - content.range.start + 1
      : content.sizeBytes;
    response.status(content.range ? 206 : 200);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Length", String(contentLength));
    response.setHeader("Content-Type", content.mimeType);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Disposition",
      `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(content.fileName)}`
    );
    if (content.range) {
      response.setHeader("Content-Range", `bytes ${content.range.start}-${content.range.end}/${content.sizeBytes}`);
    }
    content.stream.once("error", () => response.destroy());
    content.stream.pipe(response);
  }

  @Post("albums")
  createAlbum(@Body() body: CreateAlbumDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.media.createAlbum(principal, body.name, body.description);
  }

  @Post("albums/:albumId/items")
  addAlbumItem(
    @Param("albumId", ParseUUIDPipe) albumId: string,
    @Body() body: AlbumItemDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.addAlbumItem(principal, albumId, body.assetId);
  }

  @Delete("albums/:albumId/items/:assetId")
  removeAlbumItem(
    @Param("albumId", ParseUUIDPipe) albumId: string,
    @Param("assetId", ParseUUIDPipe) assetId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.media.removeAlbumItem(principal, albumId, assetId);
  }
}
