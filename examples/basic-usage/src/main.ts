import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
  console.info('Basic usage example running on http://localhost:3000');
  console.info('Try:');
  console.info('  curl -X POST http://localhost:3000/counter/increment');
  console.info('  curl http://localhost:3000/counter/value');
}
bootstrap();
