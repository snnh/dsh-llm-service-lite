/**
 * Per-route admission control.
 *
 * OWC holds each provider to three concurrent requests, and the reason is
 * worth preserving in a different runtime: a provider is a rate-limited shared
 * resource, so a swarm that fans out twenty subagents must queue behind the
 * provider rather than discover the limit as a wave of 429s. Waiting is
 * abortable, because a cancelled turn must not keep its place in line.
 *
 * @module dsh-llm-service-lite/limiter
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** One admitted request's hold on a slot. */
export interface Lease {
  /** Release the slot; safe to call once, and required on every exit path. */
  release(): void
}

/** One queued request waiting for a slot. */
interface Waiter {
  readonly signal: AbortSignal | undefined
  readonly settle: (lease: Lease) => void
  readonly fail: (error: unknown) => void
  readonly onAbort: () => void
}

/** The cancellation failure every abandoned wait reports. */
function abortedWhileQueueing(): LlmError {
  return new LlmError('llm-service-lite: request aborted while queueing', 'ABORTED')
}

/** Validate one admission ceiling. */
function assertLimit(maxConcurrent: number): void {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`ConcurrencyLimiter maxConcurrent must be a positive safe integer, received ${String(maxConcurrent)}`)
  }
}

/**
 * A FIFO admission queue with a tunable number of slots.
 *
 * A released slot is handed to the next waiter rather than returned to a pool,
 * so a request that arrives between a release and the handoff cannot overtake
 * one that has been waiting. The ceiling is tunable in place: a configuration
 * edit that changes a route's concurrency must keep this one queue, both so
 * waiting requests are never split between two limiter instances and so the
 * new ceiling is the only ceiling admission can use from then on. Requests
 * already running are never preempted.
 */
export class ConcurrencyLimiter {
  private active = 0
  private limit: number
  private readonly waiters: Waiter[] = []

  /**
   * @param maxConcurrent - slots this limiter grants before queueing.
   */
  constructor(maxConcurrent: number) {
    assertLimit(maxConcurrent)
    this.limit = maxConcurrent
  }

  /** Requests currently holding a slot. */
  get running(): number {
    return this.active
  }

  /** Requests currently waiting for a slot. */
  get queued(): number {
    return this.waiters.length
  }

  /** Slots this limiter currently grants before queueing. */
  get maxConcurrent(): number {
    return this.limit
  }

  /**
   * Re-tune the admission ceiling in place.
   *
   * A raised ceiling admits queued requests immediately; a lowered one stops
   * further admissions until running requests drop below it, without
   * interrupting any request that already holds a slot.
   * @param maxConcurrent - the next positive number of slots.
   */
  setMaxConcurrent(maxConcurrent: number): void {
    assertLimit(maxConcurrent)
    if (maxConcurrent === this.limit) return
    this.limit = maxConcurrent
    this.pump()
  }

  /**
   * Acquire one slot, waiting in FIFO order when all are held.
   * @param signal - cancellation for the wait; an already-aborted signal never queues.
   * @returns the lease whose `release()` frees the slot.
   */
  acquire(signal?: AbortSignal): Promise<Lease> {
    if (signal?.aborted === true) return Promise.reject(abortedWhileQueueing())
    if (this.active < this.limit && this.waiters.length === 0) {
      this.active += 1
      return Promise.resolve(this.lease())
    }
    return new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        settle: resolve,
        fail: reject,
        onAbort: (): void => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(abortedWhileQueueing())
        },
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Build the lease that eventually frees its slot. */
  private lease(): Lease {
    let released = false
    return {
      release: (): void => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        this.pump()
      },
    }
  }

  /** Admit queued requests while slots remain, skipping ones that were cancelled. */
  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      if (waiter === undefined) return
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal?.aborted === true) {
        waiter.fail(abortedWhileQueueing())
        continue
      }
      this.active += 1
      waiter.settle(this.lease())
    }
  }
}
