import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuditService } from "@audit/audit.service";
import { Audited } from "@audit/audited.decorator";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";
import { CreateViewDto } from "@views/dto/create-view.dto";
import { UpdateViewDto } from "@views/dto/update-view.dto";
import { type ViewRow, ViewsService, type ViewWrite } from "@views/views.service";

/**
 * Saved views (TRE-37 §1). Session guard on every route, CSRF on every mutating
 * one — the shape HostsController set.
 *
 * Create and update answer with an envelope rather than the row, because they
 * settle two facts and only one of them is the row: assigning `⌥3` to this view
 * takes it off whichever view had it, and the UI has to be able to say so. A
 * bare row would leave the client diffing two lists to work out what its own
 * write did.
 *
 * Ownership is `userId` on the row itself — a view belongs to the account, not
 * to a host — and a foreign id reads as 404, never 403.
 */
@Controller("views")
@UseGuards(SessionAuthGuard)
export class ViewsController {
  constructor(
    private readonly views: ViewsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Req() req: Request): Promise<ViewRow[]> {
    return this.views.list(userIdOf(req));
  }

  @Post()
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.CREATED)
  @Audited({
    kind: "view.create",
    describe: (request) => {
      const body = request.body as { name?: string; slot?: number | null };
      return {
        summary: `Saved the view ${body.name ?? "(unnamed)"}`,
        tag: typeof body.slot === "number" ? `alt+${body.slot}` : undefined,
      };
    },
  })
  async create(@Req() req: Request, @Body() dto: CreateViewDto): Promise<ViewWrite> {
    const written = await this.views.create(userIdOf(req), dto);
    if (written.displaced) {
      this.audit.annotate(req, {
        summary: `Saved the view ${written.view.name}, taking its shortcut from ${written.displaced.name}`,
      });
    }
    return written;
  }

  @Patch(":id")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "view.update",
    describe: (request) => ({
      summary: "Edited a view",
      payload: { requestedViewId: request.params.id },
    }),
  })
  async update(@Req() req: Request, @Param("id") id: string, @Body() dto: UpdateViewDto): Promise<ViewWrite> {
    const written = await this.views.update(userIdOf(req), id, dto);
    this.audit.annotate(req, {
      summary: written.displaced
        ? `Edited the view ${written.view.name}, taking its shortcut from ${written.displaced.name}`
        : `Edited the view ${written.view.name}`,
    });
    return written;
  }

  @Delete(":id")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "view.delete",
    describe: (request) => ({
      summary: "Deleted a view",
      payload: { requestedViewId: request.params.id },
    }),
  })
  async remove(@Req() req: Request, @Param("id") id: string): Promise<{ ok: true }> {
    const view = await this.views.remove(userIdOf(req), id);
    this.audit.annotate(req, { summary: `Deleted the view ${view.name}` });
    return { ok: true };
  }
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}
