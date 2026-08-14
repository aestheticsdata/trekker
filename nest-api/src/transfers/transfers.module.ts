import { Module } from "@nestjs/common";
import { TransferEventsService } from "@transfers/transfer-events.service";
import { TransferQueueService } from "@transfers/transfer-queue.service";
import { TransferRunnerService } from "@transfers/transfer-runner.service";
import { TransferService } from "@transfers/transfer.service";
import { TransfersController } from "@transfers/transfers.controller";

/**
 * Copy and move (TRE-23).
 *
 * Four providers, and the split between them is the ticket's own: the service
 * decides, the queue schedules, the runner moves bytes, the events service
 * tells the browser. The one dependency worth naming is the direction — the
 * queue depends on the runner and nothing depends on the queue except the
 * service that puts jobs in it, so a job in flight has no way to reach back
 * into the request that started it.
 *
 * HostsModule and AuditModule are @Global, so the driver factory, the path
 * guard and the audit service arrive without an import — the same arrangement
 * `FsModule` relies on.
 */
@Module({
  controllers: [TransfersController],
  providers: [TransferService, TransferQueueService, TransferRunnerService, TransferEventsService],
  exports: [TransferService, TransferEventsService],
})
export class TransfersModule {}
