import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { CreateViewDto } from "@views/dto/create-view.dto";
import type { UpdateViewDto } from "@views/dto/update-view.dto";
import { PrismaService } from "../prisma/prisma.service";

import type { Prisma } from "../../generated/prisma/client";

/**
 * Saved views (TRE-37 §1).
 *
 * A view belongs to the account directly — unlike a bookmark, which reaches its
 * owner through a host — so every query filters on `userId` and a row that is
 * not yours reads as 404 rather than 403. The response must not confirm the id
 * exists, which is the convention HostsService set in TRE-12.
 *
 * Two constraints do real work here and neither is enforced in application
 * code alone:
 *
 *   `@@unique([userId, name])` — two views called `deploy` is a list nobody can
 *   read, and the check has to be the database's because two tabs can both find
 *   the name free.
 *
 *   `@@unique([userId, slot])` — the shortcut. MySQL counts every NULL as
 *   distinct, so any number of views may have no chord, and only a second
 *   claim on `⌥3` collides.
 *
 * The second one is why assigning a taken shortcut **moves** it rather than
 * failing. A refusal would be correct and useless: the operator wants ⌥3 to be
 * this view, and the only thing standing in the way is a decision they are
 * entitled to change. So the write clears the other view's slot in the same
 * transaction and says which view lost it — silently moving a shortcut is how
 * somebody finds out months later that ⌥3 stopped opening what it used to.
 */

export interface ViewRow {
  id: string;
  name: string;
  /** 1–9, or null. The digit; the front spells it `⌥3`. */
  slot: number | null;
  /** The front's `ViewLayout`, validated on the way in by `ViewLayoutDto`. */
  layout: unknown;
  /** Host id to the label it had when this was saved. A memo, never compared. */
  hostLabels: Record<string, string>;
}

/** What a write moved out of the way, or null when it moved nothing. */
export interface Displaced {
  id: string;
  name: string;
}

export interface ViewWrite {
  view: ViewRow;
  displaced: Displaced | null;
}

/**
 * How many host labels one view may memo.
 *
 * A view has two panes and therefore at most two hosts. The ceiling is four
 * because a view rebound to other machines keeps being useful with the old
 * names in it, and because a column an authenticated caller can write into
 * wants a bound that is not "whatever JSON fits".
 */
const MAX_HOST_LABELS = 4;

@Injectable()
export class ViewsService {
  private readonly logger = new Logger(ViewsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every view this account has, oldest first.
   *
   * Creation order, not name order: the strip in the top bar shows the first
   * few and hides the rest behind `+n`, and a list that reordered itself when a
   * view was renamed would move the chips somebody has learned the position of.
   */
  async list(userId: string): Promise<ViewRow[]> {
    const rows = await this.prisma.views.findMany({
      where: { userId },
      orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    });
    return rows.map(toRow);
  }

  async create(userId: string, dto: CreateViewDto): Promise<ViewWrite> {
    const slot = dto.slot ?? null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Cleared before the insert, inside the same transaction: the unique
        // index is the thing being worked around, and doing it in two round
        // trips would leave a window where neither view holds the chord.
        const displaced = slot === null ? null : await releaseSlot(tx, userId, slot, null);

        const created = await tx.views.create({
          data: {
            userId,
            name: dto.name.trim(),
            slot,
            layout: asJson(dto.layout),
            hostLabels: asJson(capLabels(dto.hostLabels)),
          },
        });
        return { view: toRow(created), displaced };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException("A view of that name already exists");
      throw error;
    }
  }

  async update(userId: string, id: string, dto: UpdateViewDto): Promise<ViewWrite> {
    await this.require(userId, id);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // `undefined` leaves the chord alone; `null` clears it; a number claims
        // it, taking it off whoever had it. Three cases, and the difference
        // between the first two is the picker's `none` button.
        const displaced =
          dto.slot === undefined || dto.slot === null ? null : await releaseSlot(tx, userId, dto.slot, id);

        const updated = await tx.views.update({
          where: { id },
          data: {
            name: dto.name?.trim() ?? undefined,
            slot: dto.slot === undefined ? undefined : dto.slot,
            layout: dto.layout === undefined ? undefined : asJson(dto.layout),
            hostLabels: dto.hostLabels === undefined ? undefined : asJson(capLabels(dto.hostLabels)),
          },
        });
        return { view: toRow(updated), displaced };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException("A view of that name already exists");
      throw error;
    }
  }

  async remove(userId: string, id: string): Promise<ViewRow> {
    const view = await this.require(userId, id);
    await this.prisma.views.delete({ where: { id } });
    this.logger.log(`View deleted: ${id} for user ${userId}`);
    return view;
  }

  // ---- internals ----------------------------------------------------------

  /** The row, or 404 — never 403, which would confirm the id belongs to somebody. */
  private async require(userId: string, id: string): Promise<ViewRow> {
    const found = await this.prisma.views.findFirst({ where: { id, userId } });
    if (!found) throw new NotFoundException("View not found");
    return toRow(found);
  }
}

/**
 * Takes a shortcut off whoever is holding it, and says who that was.
 *
 * `exceptId` is the view being written: re-saving a view with the shortcut it
 * already has must not report that it displaced itself, which would put a
 * sentence on screen about a change nobody made.
 */
async function releaseSlot(
  tx: TxClient,
  userId: string,
  slot: number,
  exceptId: string | null,
): Promise<Displaced | null> {
  const holder = await tx.views.findFirst({
    where: { userId, slot, ...(exceptId === null ? {} : { NOT: { id: exceptId } }) },
    select: { id: true, name: true },
  });
  if (!holder) return null;

  await tx.views.update({ where: { id: holder.id }, data: { slot: null } });
  return { id: holder.id, name: holder.name };
}

/** A memo, not a store: the first few entries, and nothing enormous. */
function capLabels(labels: Record<string, string> | undefined): Record<string, string> {
  if (!labels) return {};
  return Object.fromEntries(
    Object.entries(labels)
      .filter(([, label]) => typeof label === "string")
      .slice(0, MAX_HOST_LABELS)
      .map(([id, label]) => [id.slice(0, 36), label.slice(0, 64)]),
  );
}

// Prisma's generated types are heavy; the alias keeps the signature above
// readable without importing the whole client namespace. The same one
// HostsService uses.
type TxClient = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];

/**
 * A validated object on its way into a Json column.
 *
 * Prisma's `InputJsonValue` wants an index signature, and an instance produced
 * by `class-transformer` has none — so the widening has to be written down. It
 * goes through a function rather than an `as` at the call site because that is
 * precisely the assertion `eslint --fix` deletes as redundant, and the build
 * then fails two files away from the line that caused it.
 */
function asJson(value: object): Prisma.InputJsonValue {
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

function toRow(row: { id: string; name: string; slot: number | null; layout: unknown; hostLabels: unknown }): ViewRow {
  return {
    id: row.id,
    name: row.name,
    slot: row.slot,
    layout: row.layout,
    // Json columns come back as `unknown`, and this one is a memo written by
    // the front. Anything that is not an object of strings is dropped rather
    // than passed on, so a hand-edited row cannot put a number where the UI
    // interpolates a host name.
    hostLabels: capLabels(asLabels(row.hostLabels)),
  };
}

function asLabels(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, string>;
}
