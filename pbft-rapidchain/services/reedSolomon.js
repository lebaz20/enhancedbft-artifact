// Systematic Reed-Solomon erasure coding over GF(2^8).
// Encode: transform k data shards into m parity shards.
// Reconstruct: any k of (k + m) shards suffice to recover the original data.
//
// Approach: build a (k+m)-by-k generator matrix whose top k-by-k block is the
// identity (systematic form) and whose bottom m-by-k block is derived from a
// Vandermonde matrix, then apply Gaussian elimination in GF(2^8) both to
// systematize the generator and to invert submatrices during reconstruction.
//
// Field polynomial: 0x11d (standard, same as Backblaze/JErasure/QR codes).

const FIELD_SIZE = 256
const PRIMITIVE_POLY = 0x11d // field generator polynomial x^8 + x^4 + x^3 + x^2 + 1

const EXP_TABLE = new Uint8Array(FIELD_SIZE * 2)
const LOG_TABLE = new Uint8Array(FIELD_SIZE)

;(function initTables() {
  let x = 1
  for (let i = 0; i < FIELD_SIZE - 1; i++) {
    EXP_TABLE[i] = x
    LOG_TABLE[x] = i
    x <<= 1
    // eslint-disable-next-line sonarjs/bitwise-operators
    if (x & FIELD_SIZE) x ^= PRIMITIVE_POLY
  }
  // Duplicate the exp table so we can index without a modulo on the sum path.
  for (let i = FIELD_SIZE - 1; i < EXP_TABLE.length; i++) {
    EXP_TABLE[i] = EXP_TABLE[i - (FIELD_SIZE - 1)]
  }
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]]
}

function gfDiv(a, b) {
  if (a === 0) return 0
  if (b === 0) throw new Error('divide by zero in GF(2^8)')
  return EXP_TABLE[LOG_TABLE[a] + (FIELD_SIZE - 1) - LOG_TABLE[b]]
}

// In-place Gauss-Jordan elimination on a k-by-(k+extra) augmented matrix.
// Rows are Uint8Arrays of length k+extra. Throws if the k-by-k left block is
// singular (which would mean we picked colinear rows from the generator).
function gaussJordan(rows, k, width) {
  for (let col = 0; col < k; col++) {
    // Find a pivot in column `col` at or below the diagonal.
    let pivotRow = -1
    for (let r = col; r < k; r++) {
      if (rows[r][col] !== 0) {
        pivotRow = r
        break
      }
    }
    if (pivotRow === -1) throw new Error('singular matrix during elimination')
    if (pivotRow !== col) {
      const tmp = rows[col]
      rows[col] = rows[pivotRow]
      rows[pivotRow] = tmp
    }
    // Normalize the pivot row so rows[col][col] === 1.
    const pivotVal = rows[col][col]
    if (pivotVal !== 1) {
      const pivotLog = LOG_TABLE[pivotVal]
      const row = rows[col]
      for (let c = col; c < width; c++) {
        if (row[c] !== 0) {
          row[c] = EXP_TABLE[LOG_TABLE[row[c]] + (FIELD_SIZE - 1) - pivotLog]
        }
      }
    }
    // Eliminate `col` from every other row.
    for (let r = 0; r < k; r++) {
      if (r === col) continue
      const factor = rows[r][col]
      if (factor === 0) continue
      const factorLog = LOG_TABLE[factor]
      const src = rows[col]
      const dst = rows[r]
      for (let c = col; c < width; c++) {
        if (src[c] !== 0) {
          dst[c] ^= EXP_TABLE[LOG_TABLE[src[c]] + factorLog]
        }
      }
    }
  }
}

// Build the (k+m)-by-k systematic generator matrix. Top k rows are identity;
// bottom m rows are the parity coefficients derived from a Vandermonde matrix
// systematized by Gauss-Jordan.
function buildGenerator(k, m) {
  const total = k + m
  // Vandermonde: V[i][j] = i^j in GF(2^8), with i taken as (i+1) to avoid the
  // zero row (0^0 = 1 but 0^j = 0 for j > 0, making the row degenerate).
  const vander = new Array(total)
  for (let i = 0; i < total; i++) {
    const row = new Uint8Array(k)
    let power = 1
    const base = i + 1 // 1..total (distinct nonzero field elements)
    for (let j = 0; j < k; j++) {
      row[j] = power
      power = gfMul(power, base)
    }
    vander[i] = row
  }

  // To systematize: compute inverse of the top k-by-k block of `vander`, then
  // right-multiply all rows by that inverse. Result: top block is identity,
  // bottom m rows are the parity coefficients.
  const topAugmented = new Array(k)
  for (let i = 0; i < k; i++) {
    const row = new Uint8Array(2 * k)
    row.set(vander[i], 0)
    row[k + i] = 1 // identity augmentation
    topAugmented[i] = row
  }
  gaussJordan(topAugmented, k, 2 * k)
  // Extract the inverse from columns [k..2k).
  const topInverse = new Array(k)
  for (let i = 0; i < k; i++) {
    topInverse[i] = topAugmented[i].slice(k, 2 * k)
  }

  // Right-multiply each vander row by topInverse to get the systematic matrix.
  const generator = new Array(total)
  for (let i = 0; i < total; i++) {
    const row = new Uint8Array(k)
    for (let j = 0; j < k; j++) {
      let sum = 0
      for (let l = 0; l < k; l++) {
        sum ^= gfMul(vander[i][l], topInverse[l][j])
      }
      row[j] = sum
    }
    generator[i] = row
  }
  return generator
}

// Compute parity[p] = sum over d of matrix[k+p][d] * data[d], byte-wise.
function encodeParity(generator, k, m, data) {
  const shardSize = data[0].length
  const parity = new Array(m)
  for (let p = 0; p < m; p++) {
    parity[p] = new Uint8Array(shardSize)
  }
  for (let p = 0; p < m; p++) {
    const coeffs = generator[k + p]
    const out = parity[p]
    for (let d = 0; d < k; d++) {
      const coeff = coeffs[d]
      if (coeff === 0) continue
      const coeffLog = LOG_TABLE[coeff]
      const dataShard = data[d]
      for (let b = 0; b < shardSize; b++) {
        const v = dataShard[b]
        if (v !== 0) out[b] ^= EXP_TABLE[LOG_TABLE[v] + coeffLog]
      }
    }
  }
  return parity
}

// Reconstruct missing data shards. `shards` is length (k+m); each entry is
// either a Uint8Array of length shardSize (present) or null (missing).
// Fills in nulls among the data-shard slots [0..k) in place. Parity slots are
// not repaired (we only need the data back to recover the payload).
function reconstruct(generator, k, m, shards) {
  const total = k + m
  const firstPresent = shards.find((s) => s !== null)
  const shardSize = firstPresent.length

  // Fast path: all data shards present, nothing to do.
  let missingDataCount = 0
  for (let i = 0; i < k; i++) if (shards[i] === null) missingDataCount++
  if (missingDataCount === 0) return

  // Collect the first k available shard indices (data preferred, then parity).
  const availableIndices = []
  for (let i = 0; i < total && availableIndices.length < k; i++) {
    if (shards[i] !== null) availableIndices.push(i)
  }
  if (availableIndices.length < k) {
    throw new Error(
      `too few shards for reconstruction: have ${availableIndices.length}, need ${k}`
    )
  }

  // Build a k-by-k sub-generator from the rows corresponding to available
  // shards, then invert it. `available_data = subgen * original_data`, so
  // `original_data = subgen^{-1} * available_data`.
  const subgenAugmented = new Array(k)
  for (let i = 0; i < k; i++) {
    const row = new Uint8Array(2 * k)
    row.set(generator[availableIndices[i]], 0)
    row[k + i] = 1
    subgenAugmented[i] = row
  }
  gaussJordan(subgenAugmented, k, 2 * k)
  const subgenInverse = new Array(k)
  for (let i = 0; i < k; i++) {
    subgenInverse[i] = subgenAugmented[i].slice(k, 2 * k)
  }

  // Only recompute the data shards that are missing.
  const availableShardData = availableIndices.map((idx) => shards[idx])
  for (let d = 0; d < k; d++) {
    if (shards[d] !== null) continue
    const coeffs = subgenInverse[d]
    const out = new Uint8Array(shardSize)
    for (let s = 0; s < k; s++) {
      const coeff = coeffs[s]
      if (coeff === 0) continue
      const coeffLog = LOG_TABLE[coeff]
      const src = availableShardData[s]
      for (let b = 0; b < shardSize; b++) {
        const v = src[b]
        if (v !== 0) out[b] ^= EXP_TABLE[LOG_TABLE[v] + coeffLog]
      }
    }
    shards[d] = out
  }
}

// Cache generator matrices keyed by (k, m) — building one costs an O(k^3)
// Gauss-Jordan pass, so reuse across calls with the same parameters.
const generatorCache = new Map()
function getGenerator(k, m) {
  const key = k * 1024 + m
  let g = generatorCache.get(key)
  if (!g) {
    g = buildGenerator(k, m)
    generatorCache.set(key, g)
  }
  return g
}

module.exports = {
  encodeParity(dataShards, parityShardCount) {
    const k = dataShards.length
    const m = parityShardCount
    if (k < 1) throw new Error('need at least one data shard')
    if (m < 1) throw new Error('need at least one parity shard')
    const shardSize = dataShards[0].length
    for (const s of dataShards) {
      if (s.length !== shardSize) throw new Error('all shards must be same size')
    }
    return encodeParity(getGenerator(k, m), k, m, dataShards)
  },

  reconstruct(shards, dataShardCount, parityShardCount) {
    const k = dataShardCount
    const m = parityShardCount
    if (shards.length !== k + m) {
      throw new Error(`expected ${k + m} shard slots, got ${shards.length}`)
    }
    if (!shards.some((s) => s !== null)) throw new Error('no shards present')
    reconstruct(getGenerator(k, m), k, m, shards)
  },

  // Exposed for testing.
  _gfMul: gfMul,
  _gfDiv: gfDiv,
  _buildGenerator: buildGenerator
}
