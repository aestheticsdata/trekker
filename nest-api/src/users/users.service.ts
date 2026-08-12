import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { compare, hash, hashSync } from "bcryptjs";
import { RedisService } from "@redis/redis.service";
import { generateRecoveryPassphrase } from "@users/recovery-passphrase.util";
import { isOwnerSlotViolation, roleFields, roleForNewAccount, type UserRole } from "@users/owner";
import type { AddUserDto } from "@users/dto/add-user.dto";
import { PrismaService } from "../prisma/prisma.service";
import type { Users } from "../../generated/prisma/client";

const BCRYPT_ROUNDS = 10;

/**
 * Compared against when no account matches, so a request for an unknown email
 * costs the same as one for a known email with the wrong password. Without it,
 * response time enumerates accounts.
 */
const TIMING_EQUALISER_HASH = hashSync("no-such-account", BCRYPT_ROUNDS);

const SIGN_IN_WINDOW_SECONDS = 15 * 60;
const SIGN_IN_MAX_ATTEMPTS = 10;
/**
 * Recovery is deliberately far tighter than sign-in. The passphrase is a
 * high-entropy secret that never rotates and is often written down — online
 * guessing has to be pointless, not merely slow.
 */
const RECOVERY_WINDOW_SECONDS = 60 * 60;
const RECOVERY_MAX_ATTEMPTS = 5;

export interface PublicUser {
  id: string;
  email: string;
  hasRecoveryPassphrase: boolean;
  /**
   * Sent to the client so the install's owner can be confirmed without a
   * database client — `curl /api/users/me` after a deploy answers whether the
   * migration's backfill landed on the row it was meant to.
   */
  role: UserRole;
}

export interface SignInResponse {
  user: PublicUser;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async signIn(email: string, password: string, ip: string): Promise<SignInResponse> {
    await this.throttle("signin", email, ip, SIGN_IN_MAX_ATTEMPTS, SIGN_IN_WINDOW_SECONDS);

    const user = await this.prisma.users.findUnique({ where: { email } });

    // Always run a comparison, even with no user, so the two cases take the
    // same time. Same reason the error message below does not distinguish them.
    const matches = await compare(password, user?.passwordHash ?? TIMING_EQUALISER_HASH);

    if (!user || !matches) {
      this.logger.warn(`Failed sign-in for ${email} from ${ip}`);
      throw new UnauthorizedException("Invalid email or password");
    }

    await this.clearAttempts("signin", email, ip);
    return { user: toPublicUser(user) };
  }

  /**
   * Creates the account and returns the recovery passphrase in the clear — the
   * only time it exists outside a hash. The caller must show it once and never
   * store it.
   */
  async addUser(dto: AddUserDto): Promise<SignInResponse & { recoveryPassphrase: string }> {
    const existing = await this.prisma.users.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException("Email already exists");
    }

    // Chosen when the registration screen sends one, generated otherwise —
    // a caller with no human in front of it must still get a real passphrase
    // rather than an empty column.
    const recoveryPassphrase = dto.passphrase ?? generateRecoveryPassphrase();
    const data = {
      email: dto.email,
      passwordHash: await hash(dto.password, BCRYPT_ROUNDS),
      recoveryPassphraseHash: await hash(recoveryPassphrase, BCRYPT_ROUNDS),
    };

    // The first account on an install owns it (TRE-48). One count, on the
    // registration route only — never anywhere near a filesystem path.
    const role = await roleForNewAccount(this.prisma.users);

    let user: Users;
    try {
      user = await this.prisma.users.create({ data: { ...data, ...roleFields(role) } });
    } catch (error) {
      // The count read an empty table and the unique index disagrees, so
      // somebody else won the first-account race. Retrying as a member rather
      // than failing is deliberate: the loser of that race still asked for an
      // account, and the only thing they must not be given is the privilege.
      // Narrow, not blanket — a duplicate email is the other race the check
      // above cannot close, and that one still has to surface.
      if (!isOwnerSlotViolation(error)) throw error;
      user = await this.prisma.users.create({ data: { ...data, ...roleFields("MEMBER") } });
    }

    return { user: toPublicUser(user), recoveryPassphrase };
  }

  /**
   * Resets the password from the recovery passphrase and destroys every session
   * the account has. If the passphrase leaked, whoever used it must not keep a
   * live session; if it did not, the legitimate owner losing their other
   * sessions is a small price.
   */
  async recover(email: string, passphrase: string, newPassword: string, ip: string): Promise<void> {
    await this.throttle("recover", email, ip, RECOVERY_MAX_ATTEMPTS, RECOVERY_WINDOW_SECONDS);

    const user = await this.prisma.users.findUnique({ where: { email } });
    const matches = await compare(passphrase, user?.recoveryPassphraseHash ?? TIMING_EQUALISER_HASH);

    if (!user || !user.recoveryPassphraseHash || !matches) {
      this.logger.warn(`Failed recovery for ${email} from ${ip}`);
      // One message for three different failures — unknown account, no
      // passphrase set, wrong passphrase. Telling them apart is free
      // reconnaissance.
      throw new UnauthorizedException("Invalid email or recovery passphrase");
    }

    await this.prisma.users.update({
      where: { id: user.id },
      data: { passwordHash: await hash(newPassword, BCRYPT_ROUNDS) },
    });

    await this.redis.clearSessionsForUser(user.id);
    await this.clearAttempts("recover", email, ip);
    this.logger.log(`Password recovered for ${email}; all sessions revoked`);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId } });

    if (!(await compare(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException("Current password is incorrect");
    }

    await this.prisma.users.update({
      where: { id: userId },
      data: { passwordHash: await hash(newPassword, BCRYPT_ROUNDS) },
    });
  }

  async findById(userId: string): Promise<SignInResponse> {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) {
      // The session outlived the account. Treat it as no session at all.
      throw new UnauthorizedException("Session required");
    }
    return { user: toPublicUser(user) };
  }

  /**
   * Counts per account and per IP. Per account alone lets a botnet spread an
   * attack across addresses; per IP alone lets one address work through a list
   * of accounts. Neither counter is useful without the other.
   */
  private async throttle(scope: string, email: string, ip: string, max: number, windowSeconds: number): Promise<void> {
    const counts = await Promise.all([
      this.redis.countAttempt(`throttle:${scope}:email:${email.toLowerCase()}`, windowSeconds),
      this.redis.countAttempt(`throttle:${scope}:ip:${ip}`, windowSeconds),
    ]);

    if (counts.some((count) => count > max)) {
      this.logger.warn(`Throttled ${scope} for ${email} from ${ip}`);
      // Nest has no TooManyRequestsException.
      throw new HttpException("Too many attempts. Try again later.", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async clearAttempts(scope: string, email: string, ip: string): Promise<void> {
    await Promise.all([
      this.redis.resetAttempts(`throttle:${scope}:email:${email.toLowerCase()}`),
      this.redis.resetAttempts(`throttle:${scope}:ip:${ip}`),
    ]);
  }
}

function toPublicUser(user: Users): PublicUser {
  return {
    id: user.id,
    email: user.email,
    hasRecoveryPassphrase: user.recoveryPassphraseHash !== null,
    role: user.role,
  };
}
