import { refreshIntervalSeconds } from "../../lib/env";
import { syncPosDate } from "../../lib/sync";

type LambdaContext = {
  getRemainingTimeInMillis(): number;
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * EventBridge starts this Lambda once per minute. One invocation stays alive
 * for most of that minute and performs short, sequential polling cycles.
 */
export async function handler(_event: unknown, context: LambdaContext) {
  const intervalMilliseconds = refreshIntervalSeconds() * 1_000;
  let successfulCycles = 0;
  let skippedCycles = 0;
  let failedCycles = 0;
  let lastError: Error | null = null;

  while (context.getRemainingTimeInMillis() > intervalMilliseconds + 2_000) {
    const cycleStartedAt = Date.now();

    try {
      const result = await syncPosDate(undefined, {
        force: true,
        trigger: "aws-lambda-schedule",
      });
      if (result.status === "success") successfulCycles += 1;
      else skippedCycles += 1;
    } catch (error) {
      failedCycles += 1;
      lastError = error instanceof Error ? error : new Error("Unknown polling error");
      console.error("POS polling cycle failed", { message: lastError.message });
    }

    const cycleDuration = Date.now() - cycleStartedAt;
    const waitTime = Math.max(0, intervalMilliseconds - cycleDuration);
    if (context.getRemainingTimeInMillis() <= waitTime + 2_000) break;
    await sleep(waitTime);
  }

  if (successfulCycles === 0 && failedCycles > 0 && lastError) throw lastError;

  return {
    successfulCycles,
    skippedCycles,
    failedCycles,
    intervalSeconds: refreshIntervalSeconds(),
  };
}
