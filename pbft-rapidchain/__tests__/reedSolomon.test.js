const rs = require('../services/reedSolomon')

function randomShard(size) {
  const s = new Uint8Array(size)
  for (let i = 0; i < size; i++) s[i] = Math.floor(Math.random() * 256)
  return s
}

describe('GF(2^8) primitives', () => {
  test('multiplication has multiplicative identity', () => {
    for (let a = 0; a < 256; a++) {
      expect(rs._gfMul(a, 1)).toBe(a)
      expect(rs._gfMul(1, a)).toBe(a)
    }
  })

  test('multiplication is commutative and zero-absorbing', () => {
    for (let a = 0; a < 10; a++) {
      for (let b = 0; b < 10; b++) {
        expect(rs._gfMul(a, b)).toBe(rs._gfMul(b, a))
      }
      expect(rs._gfMul(a, 0)).toBe(0)
      expect(rs._gfMul(0, a)).toBe(0)
    }
  })

  test('division inverts multiplication', () => {
    for (let a = 1; a < 256; a++) {
      for (let b = 1; b < 256; b += 7) {
        expect(rs._gfDiv(rs._gfMul(a, b), b)).toBe(a)
      }
    }
  })
})

describe('generator matrix construction', () => {
  test('top k rows form the identity matrix (systematic form)', () => {
    for (const [k, m] of [
      [3, 2],
      [5, 3],
      [8, 4]
    ]) {
      const g = rs._buildGenerator(k, m)
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          expect(g[i][j]).toBe(i === j ? 1 : 0)
        }
      }
      expect(g.length).toBe(k + m)
    }
  })
})

describe('Reed-Solomon encode/reconstruct', () => {
  test('round-trip with no loss', () => {
    const k = 5
    const m = 3
    const shardSize = 32
    const data = Array.from({ length: k }, () => randomShard(shardSize))
    const parity = rs.encodeParity(data, m)

    const shards = [...data.map((s) => new Uint8Array(s)), ...parity]
    rs.reconstruct(shards, k, m)
    for (let i = 0; i < k; i++) {
      expect(Array.from(shards[i])).toEqual(Array.from(data[i]))
    }
  })

  test('reconstruct after dropping every subset of m shards', () => {
    const k = 4
    const m = 3
    const shardSize = 64
    const data = Array.from({ length: k }, () => randomShard(shardSize))
    const parity = rs.encodeParity(data, m)
    const original = [...data, ...parity].map((s) => new Uint8Array(s))

    // Enumerate every set of m indices to drop; reconstruct must always succeed
    // and recover the k data shards exactly.
    const total = k + m
    for (let mask = 0; mask < 1 << total; mask++) {
      let missing = 0
      for (let i = 0; i < total; i++) if (mask & (1 << i)) missing++
      if (missing !== m) continue

      const shards = original.map((s) => new Uint8Array(s))
      for (let i = 0; i < total; i++) {
        if (mask & (1 << i)) shards[i] = null
      }
      rs.reconstruct(shards, k, m)
      for (let i = 0; i < k; i++) {
        expect(Array.from(shards[i])).toEqual(Array.from(data[i]))
      }
    }
  })

  test('below-threshold loss throws', () => {
    const k = 3
    const m = 2
    const shardSize = 8
    const data = Array.from({ length: k }, () => randomShard(shardSize))
    const parity = rs.encodeParity(data, m)

    // Drop m+1 = 3 shards, leaving only k-1 = 2 available: cannot reconstruct.
    const shards = [...data, ...parity].map((s) => new Uint8Array(s))
    shards[0] = null
    shards[1] = null
    shards[2] = null
    expect(() => rs.reconstruct(shards, k, m)).toThrow(/too few shards/)
  })

  test('large shards round-trip', () => {
    const k = 8
    const m = 4
    const shardSize = 4096
    const data = Array.from({ length: k }, () => randomShard(shardSize))
    const parity = rs.encodeParity(data, m)
    const shards = [...data.map((s) => new Uint8Array(s)), ...parity]

    // Drop the first 4 shards (worst case for a systematic code: all data lost).
    for (let i = 0; i < 4; i++) shards[i] = null
    rs.reconstruct(shards, k, m)
    for (let i = 0; i < k; i++) {
      expect(Array.from(shards[i])).toEqual(Array.from(data[i]))
    }
  })
})
