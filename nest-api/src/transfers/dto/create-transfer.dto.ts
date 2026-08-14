import { IsIn, IsObject, IsOptional } from "class-validator";
import { CONFLICT_STRATEGIES, type ConflictStrategy } from "@transfers/transfer-plan";
import { PlanTransferDto } from "@transfers/dto/plan-transfer.dto";

/**
 * Starting one (TRE-23 §1).
 *
 * The same body as the plan, plus the answers. A blanket strategy and a map of
 * per-row overrides rather than a decision per item, and that is not only about
 * request size: a selection can walk to ten thousand entries, and a client that
 * had to echo a decision for each of them would be re-sending the server's own
 * walk back to it — a walk that is about to be redone anyway, because minutes
 * may have passed since the plan was drawn.
 *
 * So the server walks again at creation and applies these two things to what it
 * finds. An override naming an entry that no longer exists is ignored rather
 * than refused; an entry that has newly appeared is covered by the strategy.
 */
export class CreateTransferDto extends PlanTransferDto {
  @IsIn(CONFLICT_STRATEGIES)
  strategy!: ConflictStrategy;

  /**
   * `{ "reports/june.csv": "overwrite" }`, keyed by the item name the plan
   * returned. Validated as a plain object here and per entry in the service —
   * class-validator has no per-value rule for an index signature, and a bad
   * value has to produce a named refusal rather than a silent default.
   */
  @IsOptional()
  @IsObject()
  overrides?: Record<string, ConflictStrategy>;
}
