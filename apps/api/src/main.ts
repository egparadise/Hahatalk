import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { createOriginPolicy, hahaTalkClientHeader } from "./security/origin-policy.js";

const port = Number(process.env.PORT ?? 4000);
const webOrigin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.useBodyParser("json", { type: ["application/json", "application/webhook+json"] });

  app.enableCors({
    allowedHeaders: [
      "Content-Type",
      "X-HahaTalk-Part-Sha256",
      "X-HahaTalk-AI-Worker-Token",
      "X-HahaTalk-AI-Worker-Id",
      "X-HahaTalk-AI-Fencing-Token",
      "X-HahaTalk-File-Name",
      "X-HahaTalk-Ops-Token",
      hahaTalkClientHeader
    ],
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin: webOrigin
  });
  app.use(createOriginPolicy(webOrigin));
  if (process.env.HAHATALK_TRUST_PROXY === "loopback") {
    app.set("trust proxy", "loopback");
  }
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: false,
      transform: true,
      whitelist: true
    })
  );
  app.enableShutdownHooks();

  await app.listen(port, "127.0.0.1");
  console.log(`HahaTalk API listening on http://127.0.0.1:${port}`);
}

void bootstrap().catch((error: unknown) => {
  console.error("HahaTalk API startup failed.", error);
  process.exit(1);
});
