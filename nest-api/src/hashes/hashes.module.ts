import { Module } from "@nestjs/common";
import { HashEventsService } from "@hashes/hash-events.service";
import { HashQueueService } from "@hashes/hash-queue.service";
import { HashRunnerService } from "@hashes/hash-runner.service";
import { HashService } from "@hashes/hash.service";
import { HashesController } from "@hashes/hashes.controller";

/**
 * Checksums (TRE-27).
 *
 * No `imports`: Prisma, the driver factory, the path guard and the audit
 * service all arrive from `@Global()` modules. The dependency direction inside
 * is the one TransfersModule established and ScansModule kept — service →
 * queue → runner, with nothing depending on the queue except the service that
 * fills it, so the abort protocol stays in one place.
 *
 * `HashEventsService` is exported for the same reason `ScanEventsService` is:
 * TRE-28's comparison will want to know when a digest it asked for has landed,
 * and the alternative to a shared bus is a second one that fans out to the same
 * browsers.
 */
@Module({
  controllers: [HashesController],
  providers: [HashEventsService, HashRunnerService, HashQueueService, HashService],
  exports: [HashEventsService],
})
export class HashesModule {}
