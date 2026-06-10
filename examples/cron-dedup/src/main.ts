import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3002);
  console.info('Cron dedup example running on http://localhost:3002');
  console.info('');
  console.info('Watch the logs — scheduled jobs fire every 10 seconds.');
  console.info('Run a second instance on a different port to see dedup in action:');
  console.info('  PORT=3003 npm start');
  console.info('');
  console.info('  curl http://localhost:3002/jobs/history');
}
bootstrap();
