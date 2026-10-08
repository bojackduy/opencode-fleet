/** Fixed-cadence polling with one tick in flight; missed ticks are skipped. */
export function startPollLoop(
  work: (isRunning: () => boolean) => Promise<void>,
  intervalMs: number,
  onError: (error: unknown) => void,
): { stop: () => void; isRunning: () => boolean } {
  let running = true;
  let busy = false;
  const isRunning = () => running;
  const timer = setInterval(() => {
    if (!running || busy) return;
    busy = true;
    void Promise.resolve().then(() => {
      if (running) return work(isRunning);
    }).catch(onError).finally(() => { busy = false; });
  }, intervalMs);
  timer.unref?.();
  return { isRunning, stop: () => { running = false; clearInterval(timer); } };
}
