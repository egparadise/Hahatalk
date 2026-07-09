import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

const port = Number(process.env.PORT ?? 4000);

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: true
  });

  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000",
    credentials: true
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true
    })
  );

  await app.listen(port, "127.0.0.1");
  console.log(`HahaTalk API listening on http://127.0.0.1:${port}`);
}

void bootstrap();

