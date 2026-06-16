const timeouts = require('../constants/timeouts')

describe('Timeouts', () => {
  it('should have BLOCK_CREATION_TIMEOUT_MS defined', () => {
    expect(timeouts.BLOCK_CREATION_TIMEOUT_MS).toBeDefined()
    expect(typeof timeouts.BLOCK_CREATION_TIMEOUT_MS).toBe('number')
    expect(timeouts.BLOCK_CREATION_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('should have all timeout values as positive numbers', () => {
    Object.values(timeouts).forEach((timeout) => {
      expect(typeof timeout).toBe('number')
      expect(timeout).toBeGreaterThan(0)
    })
  })

  it('should have reasonable timeout values', () => {
    // Most timeouts should be reasonable (less than 5 minutes)
    Object.entries(timeouts).forEach(([key, timeout]) => {
      if (key !== 'TRANSACTION_REASSIGNMENT_TIMEOUT_MS') {
        expect(timeout).toBeLessThan(300000)
      }
    })
  })

  it('should have expected timeout constants', () => {
    expect(timeouts.BLOCK_CREATION_TIMEOUT_MS).toBe(25000)
    expect(timeouts.TRANSACTION_INACTIVITY_THRESHOLD_MS).toBe(2000)
    expect(timeouts.TRANSACTION_REASSIGNMENT_TIMEOUT_MS).toBe(60000)
  })
})
