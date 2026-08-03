/**
 * Long-task collector (G1, Chapter 8 §8.4.2). Installs a PerformanceObserver
 * for 'longtask' entries and records their durations. Call `start()` before
 * running the workload and `stop()` after to retrieve the samples.
 */
export interface LongTaskSample {
  duration: number
  startTime: number
}

export function createLongTaskCollector(): {
  start: () => void
  stop: () => LongTaskSample[]
} {
  const samples: LongTaskSample[] = []
  let observer: PerformanceObserver | null = null

  const start = (): void => {
    if (typeof PerformanceObserver === 'undefined') return
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        samples.push({ duration: entry.duration, startTime: entry.startTime })
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  }

  const stop = (): LongTaskSample[] => {
    observer?.disconnect()
    observer = null
    return samples
  }

  return { start, stop }
}
