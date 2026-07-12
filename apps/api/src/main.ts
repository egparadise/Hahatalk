import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { createOriginPolicy, hahaTalkClientHeader } from "./security/origin-policy.js";

const port = Number(process.env.PORT ?? 4000);
const webOrigin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    allowedHeaders: ["Content-Type", "X-HahaTalk-Part-Sha256", hahaTalkClientHeader],
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin: webOrigin
  });
  app.use(createOriginPolicy(webOrigin));
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
