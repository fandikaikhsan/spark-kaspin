import { refreshIntervalSeconds } from "../../lib/env";
import { businessDateForTimeZone, listStores, type Store } from "../../lib/stores";
import {
  cleanupSyncRuns,
  completeSyncRun,
  createSyncRun,
  syncStoreData,
} from "../../lib/sync";

type LambdaContext = {
  getRemainingTimeInMillis(): number;
};

type StoreRunState = {
  store: Store;
  date: string;
  runId: number;
  successfulCycles: number;
  failedCycles: number;
  transactionCount: number;
  itemCount: number;
  lastError: Error | null;
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * EventBridge starts this Lambda once per minute. The invocation creates one
 * audit row per store, then performs short polling cycles for most of the minute.
 */
export async function handler(_event: unknown, context: LambdaContext) {
  const invocationStartedAt = new Date();
  const intervalMilliseconds = refreshIntervalSeconds() * 1_000;
  const stores = await listStores(true);
  if (!stores.length) throw new Error("No active stores are configured");

  const states: StoreRunState[] = [];
  for (const store of stores) {
    const date = businessDateForTimeZone(store.timeZone, invocationStartedAt);
    states.push({
      store,
      date,
      runId: await createSyncRun(store, date, "aws-lambda-schedule"),
      successfulCycles: 0,
      failedCycles: 0,
      transactionCount: 0,
      itemCount: 0,
      lastError: null,
    });
  }

  // Keep enough time to finalize every store's summary row before timeout.
  while (context.getRemainingTimeInMillis() > intervalMilliseconds + 5_000) {
    const cycleStartedAt = Date.now();
    await Promise.all(
      states.map(async (state) => {
        try {
          const result = await syncStoreData(state.store, state.date);
          state.successfulCycles += 1;
          state.transactionCount = result.transactionCount;
          state.itemCount = result.itemCount;
        } catch (error) {
          state.failedCycles += 1;
          state.lastError = error instanceof Error ? error : new Error("Unknown polling error");
          console.error("POS polling cycle failed", {
            storeId: state.store.id,
            storeName: state.store.name,
            message: state.lastError.message,
          });
        }
      }),
    );

    const waitTime = Math.max(0, intervalMilliseconds - (Date.now() - cycleStartedAt));
    if (context.getRemainingTimeInMillis() <= waitTime + 5_000) break;
    await sleep(waitTime);
  }

  await Promise.all(
    states.map((state) =>
      completeSyncRun(state.runId, {
        status: state.successfulCycles > 0 ? "success" : "failed",
        successfulCycles: state.successfulCycles,
        failedCycles: state.failedCycles,
        transactionCount: state.transactionCount,
        itemCount: state.itemCount,
        errorMessage: state.lastError?.message,
      }),
    ),
  );

  // Run retention hourly rather than issuing redundant cleanup writes each minute.
  if (invocationStartedAt.getUTCMinutes() === 0) {
    try {
      await cleanupSyncRuns(invocationStartedAt);
    } catch (error) {
      console.error("Sync-run retention failed", {
        message: error instanceof Error ? error.message : "Unknown retention error",
      });
    }
  }

  const summaries = states.map((state) => ({
    storeId: state.store.id,
    storeName: state.store.name,
    date: state.date,
    successfulCycles: state.successfulCycles,
    failedCycles: state.failedCycles,
    transactionCount: state.transactionCount,
    itemCount: state.itemCount,
  }));

  if (states.every((state) => state.successfulCycles === 0)) {
    throw states.find((state) => state.lastError)?.lastError || new Error("Every store sync failed");
  }

  return { intervalSeconds: refreshIntervalSeconds(), stores: summaries };
}
