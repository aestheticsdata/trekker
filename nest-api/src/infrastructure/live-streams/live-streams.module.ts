import { Global, Module } from "@nestjs/common";
import { LiveStreamsService } from "@infrastructure/live-streams/live-streams.service";

/** Global: every controller that opens a stream holds it here (TRE-155). */
@Global()
@Module({
  providers: [LiveStreamsService],
  exports: [LiveStreamsService],
})
export class LiveStreamsModule {}
