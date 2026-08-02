import "dotenv/config";
import { Mailer, SendResult, CarrierKey, carrierForGateway } from "./mailer.js";

/**
 * Phone notification helper — sends a text message via the carrier's
 * email-to-SMS gateway, using the SMTP account configured in .env.
 *
 * Easy API:
 *   import { notifyPhone } from "./notify.js";
 *   await notifyPhone("XBRUSDT Mark: $84.07");
 *
 * Config (via .env):
 *   PHONE_NUMBER    US 10-digit number, e.g. "4697920081"
 *   SMS_CARRIER     carrier key, e.g. "tmobile" (see Mailer.carriers)
 *   SUBJECT         default subject line
 *   DRY_RUN=1       validate config only — log instead of sending
 *
 * SMTP credentials are read by Mailer.fromEnv() (SMTP_USER / SMTP_PASS / ...).
 * If PHONE_NUMBER/SMS_CARRIER are missing, the target is parsed from TO_ADDR
 * (e.g. "4697920081@tmomail.net").
 */

let mailer: Mailer | null = null;

/** Reuse a single Mailer (one SMTP connection pool) across calls. */
function getMailer(): Mailer {
  if (!mailer) mailer = Mailer.fromEnv();
  return mailer;
}

/** Resolve the SMS target (phone number + carrier) from the environment. */
function resolveSmsTarget(): { phone: string; carrier: CarrierKey } {
  const phone = (process.env.PHONE_NUMBER ?? "").replace(/\D/g, "");
  const carrier = (process.env.SMS_CARRIER ?? "").trim().toLowerCase();

  if (phone && carrier) {
    if (!(Mailer.carriers as readonly string[]).includes(carrier)) {
      throw new Error(
        `Unknown SMS_CARRIER "${carrier}". Known carriers: ${Mailer.carriers.join(", ")}`,
      );
    }
    return { phone, carrier: carrier as CarrierKey };
  }

  // Fallback: parse TO_ADDR like "4697920081@tmomail.net"
  const to = (process.env.TO_ADDR ?? "").trim();
  const match = to.match(/^(\d{10,})@([^@]+)$/);
  const carrierKey = match ? carrierForGateway(match[2]) : undefined;
  if (match && carrierKey) {
    return { phone: match[1], carrier: carrierKey };
  }

  throw new Error(
    "SMS target not configured. Set PHONE_NUMBER and SMS_CARRIER in .env " +
      "(or TO_ADDR=<number>@<carrier gateway>).",
  );
}

/** True when notifications are disabled (DRY_RUN=1). */
export function isDryRun(): boolean {
  return process.env.DRY_RUN === "1";
}

/**
 * Send a text message to the phone configured in .env.
 *
 * @param message  SMS body text
 * @param subject  Optional subject line (defaults to SUBJECT env var)
 * @returns the send result, or null in dry-run mode
 * @throws if the SMTP/SMS target is not configured or sending fails
 */
export async function notifyPhone(
  message: string,
  subject?: string,
): Promise<SendResult | null> {
  const { phone, carrier } = resolveSmsTarget();
  const resolvedSubject = subject ?? process.env.SUBJECT;

  if (isDryRun()) {
    console.log(`[notify] DRY_RUN — would SMS ${phone} (${carrier}): ${message}`);
    return null;
  }

  return getMailer().sendSMS(phone, carrier, message, resolvedSubject);
}
