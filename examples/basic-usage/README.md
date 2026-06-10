# nestjs-redlock — basic-usage example

Shows the two main ways to use `nestjs-redlock`:

1. **`@Lock()` decorator** — declarative, zero boilerplate on a controller method.
2. **`LockService.withLock()`** — programmatic, use anywhere a service is injected.

## Run

```bash
# Start Redis
docker run -p 6379:6379 redis:7-alpine

# Install & start
npm install
npm start
```

## Try it

```bash
# Increment counter (protected by lock)
curl -X POST http://localhost:3000/counter/increment

# Read current value
curl http://localhost:3000/counter/value
```

## What this shows

- `LockModule.register()` — single registration, globally available
- Static lock key (`key: 'counter'`)
- Lock TTL override (`duration: 5000`)
- `LockService` injected into a service for programmatic locking
- `@Lock()` on a controller method for declarative locking
