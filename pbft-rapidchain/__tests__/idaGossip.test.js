const IDAGossip = require('../services/idaGossip')

jest.mock('../config', () => ({
  get: () => ({
    NUMBER_OF_NODES: 4,
    NUMBER_OF_NODES_PER_SHARD: 4,
    DEFAULT_TTL: 3
  })
}))

function feedChunks(receiver, chunks) {
  for (const chunk of chunks) {
    const result = receiver.handleChunk({
      chunkKey: 'payload',
      shouldGossip: false,
      ttl: 0,
      payload: chunk
    })
    if (result) return result
  }
  return undefined
}

describe('IDAGossip Reed-Solomon', () => {
  test('round-trip: all chunks present reconstructs payload', () => {
    const sender = new IDAGossip()
    const receiver = new IDAGossip()

    // Payload must exceed the 2 KB small-payload bypass to exercise RS.
    const payload = { block: 'x'.repeat(10 * 1024) }
    const chunks = sender.splitData(payload)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].dataShards).toBeGreaterThan(0)
    expect(chunks[0].parityShards).toBeGreaterThan(0)

    const result = feedChunks(receiver, chunks)
    expect(result).toBeDefined()
    expect(result.payload).toEqual(payload)
  })

  test('threshold recovery: any dataShards-of-total chunks reconstructs', () => {
    const sender = new IDAGossip()
    const receiver = new IDAGossip()

    const payload = { block: 'x'.repeat(20 * 1024) } // 20 KB → multi-shard
    const chunks = sender.splitData(payload)
    const { dataShards, parityShards } = chunks[0]
    expect(parityShards).toBeGreaterThan(0)

    // Drop the first `parityShards` chunks (worst case: lose data shards, keep
    // parity). This is exactly the m-of-n property Rabin's IDA guarantees and
    // that the previous replication-based scheme did NOT provide.
    const surviving = chunks.slice(parityShards)
    expect(surviving.length).toBe(dataShards)

    const result = feedChunks(receiver, surviving)
    expect(result).toBeDefined()
    expect(result.payload).toEqual(payload)
  })

  test('below-threshold loss returns undefined until enough chunks arrive', () => {
    const sender = new IDAGossip()
    const receiver = new IDAGossip()

    const payload = { block: 'y'.repeat(20 * 1024) }
    const chunks = sender.splitData(payload)
    const { dataShards } = chunks[0]

    const insufficient = chunks.slice(0, dataShards - 1)
    expect(feedChunks(receiver, insufficient)).toBeUndefined()

    const finalChunk = chunks[dataShards - 1]
    const result = receiver.handleChunk({
      chunkKey: 'payload',
      shouldGossip: false,
      ttl: 0,
      payload: finalChunk
    })
    expect(result).toBeDefined()
    expect(result.payload).toEqual(payload)
  })

  test('small payload (< 2 KB) bypasses fragmentation', () => {
    const sender = new IDAGossip()
    const receiver = new IDAGossip()

    const payload = { small: 'message' }
    const chunks = sender.splitData(payload)
    expect(chunks.length).toBe(1)
    expect(chunks[0].totalChunks).toBe(1)
    expect(chunks[0].parityShards).toBeUndefined()

    const result = feedChunks(receiver, chunks)
    expect(result).toBeDefined()
    expect(result.payload).toEqual(payload)
  })

  test('duplicate chunk delivery is idempotent', () => {
    const sender = new IDAGossip()
    const receiver = new IDAGossip()

    const payload = { block: 'z'.repeat(20 * 1024) }
    const chunks = sender.splitData(payload)
    const { dataShards } = chunks[0]

    // Deliver dataShards distinct chunks, each twice, in interleaved order.
    const withDupes = []
    for (let i = 0; i < dataShards; i++) {
      withDupes.push(chunks[i], chunks[i])
    }
    const result = feedChunks(receiver, withDupes)
    expect(result).toBeDefined()
    expect(result.payload).toEqual(payload)
  })
})
