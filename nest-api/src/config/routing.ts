import type { NestApplicationOptions } from "@nestjs/common";

/**
 * How routes are registered and checked (TRE-155), shared by `main.ts` and the specs that boot an
 * app, so they register routes exactly as production does.
 *
 * - `specificity`: literal segments are registered before parametric ones, so a literal route never
 *   depends on being declared before its `:id` neighbour.
 * - A duplicate route (same method and path twice) stops the boot.
 * - Shadows are not reported: the detector ignores the strategy and flags the overlaps it resolves
 *   on purpose — `reorder` beside `/bookmarks/:id` and `stream` beside `/transfers/:id`, where an ID
 *   is a UUID and never one of those words.
 */
export const ROUTING_OPTIONS = {
  routeResolutionStrategy: "specificity",
  routeConflictPolicy: { duplicate: "error", shadow: "off" },
} as const satisfies NestApplicationOptions;
