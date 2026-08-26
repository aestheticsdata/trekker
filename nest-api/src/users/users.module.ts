import { Module } from "@nestjs/common";
import { UsersController } from "@users/users.controller";
import { UsersService } from "@users/users.service";

/**
 * `SudoService` and `AuditService` inject into the controller without being
 * imported here: HostsModule and AuditModule are both `@Global`, the same way
 * FsModule reaches them. Sign-out needs the first of those because a sudo
 * window outliving the session it belongs to would be a root password held for
 * a session that no longer exists (TRE-29) — and since TRE-92, sign-in needs it
 * for the same reason, because regenerating the session id strands any window
 * still keyed by the old one.
 */
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
