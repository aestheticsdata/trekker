import { Module } from "@nestjs/common";
import { ScanEventsService } from "@scans/scan-events.service";
import { ScanQueueService } from "@scans/scan-queue.service";
import { ScanRunnerService } from "@scans/scan-runner.service";
import { ScanService } from "@scans/scan.service";
import { ScansController } from "@scans/scans.controller";

/**
 * Disk scans (TRE-32).
 *
 * No `imports`: Prisma, the driver factory, the path guard and the audit
 * service all arrive from `@Global()` modules. The dependency direction inside
 * is the one TransfersModule established and is worth keeping — service →
 * queue → runner, with nothing depending on the queue except the service that
 * fills it, so the boot hook and the abort protocol stay in one place.
 */
@Module({
  controllers: [ScansController],
  providers: [ScanEventsService, ScanRunnerService, ScanQueueService, ScanService],
  exports: [ScanEventsService],
})
export class ScansModule {}
