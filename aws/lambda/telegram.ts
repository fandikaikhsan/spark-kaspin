import { refreshIntervalSeconds } from "../../lib/env";
import { businessDateForTimeZone, listStores, type Store } from "../../lib/stores";
import { syncPosDate } from "../../lib/sync";

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

function findStore(stores: Store[], identifier: string): Store | null {
  const normalized = identifier.toLowerCase();
  const matches = stores.filter(
    (store) => store.id.startsWith(identifier) || store.name.toLowerCase() === normalized,
  );
  return matches.length === 1 ? matches[0] : null;
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

    const [command, firstArgument, secondArgument] = message.text.trim().split(/\s+/, 3);
    const stores = await listStores(true);

    if (command === "/sync") {
      if (!stores.length) {
        await sendTelegramMessage(message.chat.id, "No active stores are configured.");
        return response(200, { ok: true });
      }

      let store: Store | null = stores.length === 1 ? stores[0] : null;
      let requestedDate: string | undefined;
      if (stores.length === 1 && firstArgument?.match(/^\d{4}-\d{2}-\d{2}$/)) {
        requestedDate = firstArgument;
      } else if (firstArgument) {
        store = findStore(stores, firstArgument);
        requestedDate = secondArgument;
      }

      if (!store) {
        await sendTelegramMessage(
          message.chat.id,
          "Choose a store: /sync <store-id> [YYYY-MM-DD]. Use /stores to list IDs.",
        );
        return response(200, { ok: true });
      }

      const date = requestedDate || businessDateForTimeZone(store.timeZone);
      const result = await syncPosDate(store, date, { force: true, trigger: "telegram" });
      await sendTelegramMessage(
        message.chat.id,
        `${store.name}: sync ${result.status} for ${result.date}: ${result.transactionCount} transactions, ${result.itemCount} item lines.`,
      );
    } else if (command === "/status") {
      const lines = stores.map(
        (store) => `${store.name}: ${businessDateForTimeZone(store.timeZone)} (${store.utcOffset})`,
      );
      await sendTelegramMessage(
        message.chat.id,
        `POS ingestion is online. Polling interval: ${refreshIntervalSeconds()} seconds.\n${lines.join("\n")}`,
      );
    } else if (command === "/stores") {
      const lines = stores.map(
        (store) => `${store.id.slice(0, 8)} — ${store.name} (${store.utcOffset})`,
      );
      await sendTelegramMessage(message.chat.id, lines.join("\n") || "No active stores configured.");
    } else {
      await sendTelegramMessage(
        message.chat.id,
        "Commands: /stores, /sync <store-id> [YYYY-MM-DD], and /status",
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Telegram handler failed";
    console.error("Telegram webhook failed", { message: errorMessage });
    return response(500, { error: "Webhook processing failed" });
  }

  return response(200, { ok: true });
}
