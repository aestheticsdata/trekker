import { HttpException, HttpStatus } from "@nestjs/common";

import type { DriverError } from "@hosts/drivers/driver-error";

/**
 * Driver failures become the three responses the client switches on
 * (TRE-13 §5). A permission denial must never reach the UI as an empty
 * directory — that is the one mapping that would quietly lie.
 *
 * Its own file because TRE-21 writes as well as reads, and two copies of this
 * table would drift the day one of them learns a new code.
 */
export function toHttp(error: DriverError): HttpException {
  const body = (status: HttpStatus, message: string): HttpException =>
    new HttpException({ statusCode: status, code: error.code, message }, status);

  switch (error.code) {
    case "ENOENT":
      return body(HttpStatus.NOT_FOUND, "No such file or directory");
    case "EACCES":
    case "EPERM":
      // 403 with a code of its own: distinguishable from the guard's refusal,
      // which means "outside your roots" rather than "the host said no".
      return body(HttpStatus.FORBIDDEN, "Permission denied on the host");
    case "ENOTDIR":
      return body(HttpStatus.BAD_REQUEST, "Not a directory");
    // TRE-10 §3: the mismatch must read as its own thing. The `code` already
    // distinguished it, but the message did not, and the message is what a
    // person sees — telling someone to check the network during a host key
    // change is the worst possible advice, because the host answered fine.
    case "EHOSTKEY":
      return body(HttpStatus.BAD_GATEWAY, "The host key does not match the pinned fingerprint");
    case "EAUTH":
      return body(HttpStatus.BAD_GATEWAY, "The host refused the credential");
    case "EUNREACHABLE":
    case "ETIMEDOUT":
      return body(HttpStatus.BAD_GATEWAY, "The host could not be reached");
    default:
      return body(HttpStatus.INTERNAL_SERVER_ERROR, "The host returned an unexpected error");
  }
}
