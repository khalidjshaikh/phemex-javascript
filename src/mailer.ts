import "dotenv/config";
import nodemailer, { TransportOptions } from "nodemailer";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MailerConfig {
  /** SMTP host (default: smtp.gmail.com) */
  host: string;
  /** SMTP port (default: 587) */
  port: number;
  /** SMTP username (usually an email address) */
  user: string;
  /** SMTP password or app password */
  pass: string;
  /** Default From address (defaults to user) */
  from: string;
  /** Use TLS (true for port 465, false for STARTTLS on 587) */
  secure: boolean;
}

export interface SendOptions {
  to: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content?: string | Buffer;
    path?: string;
    contentType?: string;
  }>;
}

export interface SendResult {
  messageId: string;
  response: string;
  accepted: string[];
  rejected: string[];
}

/** Known US carrier SMS/MMS gateway domains */
const CARRIER_GATEWAYS: Record<string, string> = {
  "att": "txt.att.net",
  "tmobile": "tmomail.net",
  "verizon": "vtext.com",
  "sprint": "messaging.sprintpcs.com",
  "comcast": "comcastpcs.textmsg.com",
  "cricket": "sms.cricketwireless.net",
  "google-fi": "msg.fi.google.com",
  "republic-wireless": "text.republicwireless.com",
  "tracfone": "mmst5.tracfone.com",
  "us-cellular": "email.uscc.net",
  "virgin-mobile": "vmobl.com",
};

// ── Mailer ─────────────────────────────────────────────────────────────────────

/**
 * A reusable mailer built on top of nodemailer.
 *
 * ```ts
 * const mailer = Mailer.fromEnv();
 * await mailer.send({ to: "user@example.com", subject: "Hi", text: "Hello!" });
 * ```
 */
export class Mailer {
  private readonly config: Required<MailerConfig>;
  private transporter: nodemailer.Transporter | null = null;

  constructor(config?: Partial<MailerConfig>) {
    this.config = {
      host: config?.host ?? "smtp.gmail.com",
      port: config?.port ?? 587,
      user: config?.user ?? "",
      pass: config?.pass ?? "",
      from: config?.from ?? config?.user ?? "",
      secure: config?.secure ?? (config?.port === 465 || false),
    };
  }

  // ── Factory ──────────────────────────────────────────────────────────────────

  /**
   * Create a Mailer from environment variables.
   *
   * Expects: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_ADDR`.
   * Throws if `SMTP_USER` or `SMTP_PASS` are missing.
   */
  static fromEnv(): Mailer {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.FROM_ADDR;

    // ── Validate required ──────────────────────────────────────────────────
    const missing: string[] = [];
    if (!user) missing.push("SMTP_USER");
    if (!pass) missing.push("SMTP_PASS");
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variable(s): ${missing.join(", ")}`
      );
    }

    const parsedPort = port ? Number(port) : 587;
    return new Mailer({
      host: host || "smtp.gmail.com",
      port: parsedPort,
      user: user!,
      pass: pass!,
      from: from || user,
      secure: parsedPort === 465,
    });
  }

  /**
   * Create a Mailer using a Gmail App Password.
   * Shortcut for `new Mailer({ host: "smtp.gmail.com", port: 587, user, pass, from })`.
   */
  static gmail(user: string, pass: string, from?: string): Mailer {
    return new Mailer({ host: "smtp.gmail.com", port: 587, user, pass, from: from ?? user });
  }

  // ── Transporter management ───────────────────────────────────────────────────

  /** Lazy-initialize and return the nodemailer transporter. */
  getTransport(): nodemailer.Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        auth: {
          user: this.config.user,
          pass: this.config.pass,
        },
      } as TransportOptions);
    }
    return this.transporter;
  }

  /** Close the transporter's connection pool if it exists. */
  async close(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
  }

  // ── Send ─────────────────────────────────────────────────────────────────────

  /**
   * Send an email with the given options.
   *
   * @returns The message ID, SMTP response, and accepted/rejected addresses.
   * @throws If the config has no user/pass or sending fails.
   */
  async send(options: SendOptions): Promise<SendResult> {
    if (!this.config.user || !this.config.pass) {
      throw new Error(
        "Mailer is not configured: SMTP user and password are required. " +
        "Use Mailer.fromEnv() or pass config to the constructor."
      );
    }

    const transporter = this.getTransport();
    const info = await transporter.sendMail({
      from: this.config.from,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      replyTo: options.replyTo,
      subject: options.subject ?? "(no subject)",
      text: options.text,
      html: options.html,
      attachments: options.attachments,
    });

    return {
      messageId: info.messageId,
      response: info.response,
      accepted: info.accepted,
      rejected: info.rejected,
    };
  }

  // ── SMS convenience ──────────────────────────────────────────────────────────

  /**
   * Send an SMS via a carrier's email-to-SMS gateway.
   *
   * @param phoneNumber   US 10-digit number (e.g. "4697920081")
   * @param carrier       Carrier key — see {@link CARRIER_GATEWAYS}
   * @param message       SMS body text
   * @param subject       Optional subject line
   */
  async sendSMS(
    phoneNumber: string,
    carrier: keyof typeof CARRIER_GATEWAYS,
    message: string,
    subject?: string,
  ): Promise<SendResult> {
    const domain = CARRIER_GATEWAYS[carrier];
    if (!domain) {
      const known = Object.keys(CARRIER_GATEWAYS).join(", ");
      throw new Error(
        `Unknown carrier "${carrier}". Known carriers: ${known}`
      );
    }
    const to = `${phoneNumber}@${domain}`;
    return this.send({ to, text: message, subject });
  }

  /** Get the list of known carrier names (for `sendSMS`). */
  static get carriers(): string[] {
    return Object.keys(CARRIER_GATEWAYS);
  }
}
