import { Module } from "@nestjs/common";
import { CompareController } from "@compare/compare.controller";
import { CompareService } from "@compare/compare.service";

/**
 * Directory comparison (TRE-28).
 *
 * No `imports`: Prisma, the driver factory, the path guard and the audit
 * service all arrive from `@Global()` modules.
 *
 * The smallest feature module in the API, and it stays that way on purpose. It
 * has no queue, no runner and no events bus because it has nothing long-running
 * to own — the expensive half of a comparison is checksums, and those belong to
 * TRE-27, which already has all three.
 */
@Module({
  controllers: [CompareController],
  providers: [CompareService],
})
export class CompareModule {}
