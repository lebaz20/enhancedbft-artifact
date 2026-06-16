const { SHARD_STATUS } = require('../constants/status')

describe('SHARD_STATUS', () => {
  it('should have normal status', () => {
    expect(SHARD_STATUS.normal).toBeDefined()
    expect(typeof SHARD_STATUS.normal).toBe('string')
    expect(SHARD_STATUS.normal).toBe('NORMAL')
  })

  it('should have under_utilized status', () => {
    expect(SHARD_STATUS.under_utilized).toBeDefined()
    expect(typeof SHARD_STATUS.under_utilized).toBe('string')
    expect(SHARD_STATUS.under_utilized).toBe('UNDER-UTILIZED')
  })

  it('should have over_utilized status', () => {
    expect(SHARD_STATUS.over_utilized).toBeDefined()
    expect(typeof SHARD_STATUS.over_utilized).toBe('string')
    expect(SHARD_STATUS.over_utilized).toBe('OVER-UTILIZED')
  })

  it('should have faulty status', () => {
    expect(SHARD_STATUS.faulty).toBeDefined()
    expect(typeof SHARD_STATUS.faulty).toBe('string')
    expect(SHARD_STATUS.faulty).toBe('FAULTY')
  })

  it('should have all unique values', () => {
    const values = Object.values(SHARD_STATUS)
    const uniqueValues = new Set(values)
    expect(uniqueValues.size).toBe(values.length)
  })

  it('should have correct number of statuses', () => {
    expect(Object.keys(SHARD_STATUS).length).toBe(4)
  })
})
