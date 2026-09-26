import { refreshIntervalSeconds } from "../../lib/env";
import { currentBusinessDate, syncPosDate } from "../../lib/sync";

type FunctionUrlEvent = {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};

type TelegramUpdate = {
  message?: {
    chat: { id: number };
    text?: string;
  };
};

type FunctionUrlResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

function response(statusCode: number, payload: object): FunctionUrlResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function header(event: FunctionUrlEvent, name: string): string | undefined {
  const target = name.toLowerCase();
  const match = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === target);
  return match?.[1];
}

async function sendTelegramMessage(chatId: number, text: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not configured");

  const result = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!result.ok) throw new Error(`Telegram sendMessage failed with HTTP ${result.status}`);
}

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResponse> {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (
    !expectedSecret ||
    header(event, "x-telegram-bot-api-secret-token") !== expectedSecret
  ) {
    return response(401, { error: "Unauthorized" });
  }

  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "{}";
    const update = JSON.parse(rawBody) as TelegramUpdate;
    const message = update.message;
    if (!message?.text) return response(200, { ok: true });

    const allowedChatId = Number(process.env.TELEGRAM_ALLOWED_CHAT_ID);
    if (!Number.isFinite(allowedChatId) || message.chat.id !== allowedChatId) {
      return response(200, { ok: true });
    }

    const [command, requestedDate] = message.text.trim().split(/\s+/, 2);

    if (command === "/sync") {
      const date = requestedDate || currentBusinessDate();
      const result = await syncPosDate(date, { force: true, trigger: "telegram" });
      await sendTelegramMessage(
        message.chat.id,
        `Sync ${result.status} for ${result.date}: ${result.transactionCount} transactions, ${result.itemCount} item lines.`,
      );
    } else if (command === "/status") {
      await sendTelegramMessage(
        message.chat.id,
        `POS ingestion is online. Polling interval: ${refreshIntervalSeconds()} seconds. Business date: ${currentBusinessDate()}.`,
      );
    } else {
      await sendTelegramMessage(message.chat.id, "Commands: /sync [YYYY-MM-DD] and /status");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Telegram handler failed";
    console.error("Telegram webhook failed", { message: errorMessage });
    return response(500, { error: "Webhook processing failed" });
  }

  return response(200, { ok: true });
}
