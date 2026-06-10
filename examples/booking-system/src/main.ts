import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3001);
  console.info('Booking system example running on http://localhost:3001');
  console.info('');
  console.info('Try booking a seat — race condition protected by lock groups:');
  console.info(
    '  curl -X POST http://localhost:3001/bookings \\\n' +
      '    -H "Content-Type: application/json" \\\n' +
      '    -d \'{"locationId":"LOC-001","seatId":"A1","userId":"user-42"}\'',
  );
  console.info('');
  console.info('Try multi-seat booking (deadlock-safe lock group):');
  console.info(
    '  curl -X POST http://localhost:3001/bookings/multi \\\n' +
      '    -H "Content-Type: application/json" \\\n' +
      '    -d \'{"locationId":"LOC-001","seatIds":["B2","A1"],"userId":"user-99"}\'',
  );
}
bootstrap();
