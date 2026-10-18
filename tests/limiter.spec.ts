import { describe, expect, it } from 'vitest'
import { ConcurrencyLimiter } from '../src/limiter.ts'

/** A promise with an externally readable settlement. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Win a race against a microtask turn, to prove a call is still waiting. */
const settled = (promise: Promise<unknown>): Promise<string> => Promise.race([
  promise.then(() => 'settled', () => 'settled'),
  new Promise<string>((resolve) => { setTimeout(() => { resolve('pending') }, 5) }),
])

describe('concurrency limiter', () => {
  it('admits up to its limit and queues the rest in arrival order', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const first = await limiter.acquire()
    const order: string[] = []
    const second = limiter.acquire().then((lease) => { order.push('second'); return lease })
    const third = limiter.acquire().then((lease) => { order.push('third'); return lease })
    expect(limiter.running).toBe(1)
    expect(limiter.queued).toBe(2)
    expect(await settled(second)).toBe('pending')
    first.release()
    const lease = await second
    expect(order).toEqual(['second'])
    lease.release()
    await third
    expect(order).toEqual(['second', 'third'])
    expect(limiter.queued).toBe(0)
  })

  it('ignores a second release and keeps its slot accounting', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const lease = await limiter.acquire()
    lease.release()
    lease.release()
    expect(limiter.running).toBe(0)
    expect(limiter.queued).toBe(0)
    const next = await limiter.acquire()
    expect(limiter.running).toBe(1)
    next.release()
  })

  it('never queues an already-aborted call', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const aborted = AbortSignal.abort()
    await expect(limiter.acquire(aborted)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(limiter.queued).toBe(0)
  })

  it('removes a queued call that aborts and lets the next one through', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const held = await limiter.acquire()
    const controller = new AbortController()
    const cancelled = limiter.acquire(controller.signal)
    const waiting = deferred<undefined>()
    const replacement = limiter.acquire().then((lease) => { waiting.resolve(undefined); return lease })
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' })
    held.release()
    await replacement
    await waiting.promise
    expect(limiter.queued).toBe(0)
  })

  it('skips a queued call that aborted without an abort listener firing again', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const held = await limiter.acquire()
    const controller = new AbortController()
    const cancelled = limiter.acquire(controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' })
    held.release()
    expect(limiter.running).toBe(0)
  })
})

describe('tunable ceiling', () => {
  it('admits queued requests immediately when the ceiling grows', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const held = await limiter.acquire()
    const queued = limiter.acquire()
    expect(limiter.queued).toBe(1)
    limiter.setMaxConcurrent(2)
    expect(limiter.maxConcurrent).toBe(2)
    const lease = await queued
    expect(limiter.running).toBe(2)
    held.release()
    lease.release()
    expect(limiter.running).toBe(0)
  })

  it('keeps one FIFO queue when the ceiling shrinks, admitting only below the new ceiling', async () => {
    const limiter = new ConcurrencyLimiter(2)
    const first = await limiter.acquire()
    const second = await limiter.acquire()
    const order: string[] = []
    const third = limiter.acquire().then((lease) => { order.push('third'); return lease })
    const fourth = limiter.acquire().then((lease) => { order.push('fourth'); return lease })
    limiter.setMaxConcurrent(1)
    expect(limiter.maxConcurrent).toBe(1)
    // A release that leaves the old active set at the new ceiling admits nothing.
    first.release()
    expect(limiter.running).toBe(1)
    expect(limiter.queued).toBe(2)
    expect(await settled(third)).toBe('pending')
    second.release()
    const thirdLease = await third
    expect(limiter.running).toBe(1)
    expect(limiter.queued).toBe(1)
    expect(order).toEqual(['third'])
    thirdLease.release()
    const fourthLease = await fourth
    expect(order).toEqual(['third', 'fourth'])
    fourthLease.release()
    expect(limiter.running).toBe(0)
  })

  it('rejects an invalid ceiling and treats an unchanged one as a no-op', () => {
    const limiter = new ConcurrencyLimiter(2)
    expect(limiter.maxConcurrent).toBe(2)
    limiter.setMaxConcurrent(2)
    expect(limiter.maxConcurrent).toBe(2)
    expect(() => { limiter.setMaxConcurrent(0) }).toThrow(/positive safe integer/)
    expect(() => { limiter.setMaxConcurrent(1.5) }).toThrow(/positive safe integer/)
    expect(() => new ConcurrencyLimiter(0)).toThrow(/positive safe integer/)
  })
})
