import { Global, Module } from "@nestjs/common";
// Relative, not aliased: an `@prisma/*` path alias would shadow the npm scope
// that `@prisma/client` and `@prisma/adapter-mariadb` live in. pfa does the
// same for the same reason.
import { PrismaService } from "./prisma.service";

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
