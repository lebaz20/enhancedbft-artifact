const RateUtility = require('../utils/rate')

describe('RateUtility', () => {
  describe('nearestMinCreatedAt', () => {
    it('should round down to nearest minute', () => {
      const date = new Date('2026-01-25T12:34:56.789Z').getTime()
      const result = RateUtility.nearestMinCreatedAt(date)
      const expected = new Date('2026-01-25T12:34:00.000Z').getTime()
      expect(result).toBe(expected)
    })

    it('should handle current time when no date provided', () => {
      const before = Math.floor(Date.now() / 60000) * 60000
      const result = RateUtility.nearestMinCreatedAt()
      const after = Math.floor(Date.now() / 60000) * 60000

      expect(result).toBeGreaterThanOrEqual(before)
      expect(result).toBeLessThanOrEqual(after)
    })

    it('should return same value for times within same minute', () => {
      const time1 = new Date('2026-01-25T12:34:10.000Z').getTime()
      const time2 = new Date('2026-01-25T12:34:50.000Z').getTime()

      expect(RateUtility.nearestMinCreatedAt(time1)).toBe(
        RateUtility.nearestMinCreatedAt(time2)
      )
    })

    it('should return different values for different minutes', () => {
      const time1 = new Date('2026-01-25T12:34:00.000Z').getTime()
      const time2 = new Date('2026-01-25T12:35:00.000Z').getTime()

      expect(RateUtility.nearestMinCreatedAt(time1)).not.toBe(
        RateUtility.nearestMinCreatedAt(time2)
      )
    })
  })

  describe('getPreviousMinute', () => {
    it('should return timestamp of previous minute', () => {
      const result = RateUtility.getPreviousMinute()
      const now = Date.now()
      const oneMinute = 60000

      expect(result).toBeLessThan(now)
      expect(now - result).toBeLessThanOrEqual(2 * oneMinute)
      expect(now - result).toBeGreaterThan(0)
    })

    it('should have zero seconds', () => {
      const result = RateUtility.getPreviousMinute()
      const date = new Date(result)

      expect(date.getSeconds()).toBe(0)
      expect(date.getMilliseconds()).toBe(0)
    })
  })

  describe('removeOlderEntries', () => {
    it('should remove entries older than 10 minutes', () => {
      const now = Date.now()
      const elevenMinutesAgo = now - 11 * 60 * 1000
      const fiveMinutesAgo = now - 5 * 60 * 1000

      const ratePerMin = {
        [elevenMinutesAgo]: 5,
        [fiveMinutesAgo]: 10
      }

      RateUtility.removeOlderEntries(ratePerMin)

      expect(ratePerMin[elevenMinutesAgo]).toBeUndefined()
      expect(ratePerMin[fiveMinutesAgo]).toBe(10)
    })

    it('should keep entries within 10 minutes', () => {
      const now = Date.now()
      const nineMinutesAgo = now - 9 * 60 * 1000
      const oneMinuteAgo = now - 1 * 60 * 1000

      const ratePerMin = {
        [nineMinutesAgo]: 3,
        [oneMinuteAgo]: 7
      }

      RateUtility.removeOlderEntries(ratePerMin)

      expect(ratePerMin[nineMinutesAgo]).toBe(3)
      expect(ratePerMin[oneMinuteAgo]).toBe(7)
    })

    it('should handle empty object', () => {
      const ratePerMin = {}
      RateUtility.removeOlderEntries(ratePerMin)
      expect(Object.keys(ratePerMin).length).toBe(0)
    })
  })

  describe('updateRatePerMin', () => {
    it('should initialize new minute entry to 1', () => {
      const ratePerMin = {}
      const date = Date.now()

      RateUtility.updateRatePerMin(ratePerMin, date)

      const key = RateUtility.nearestMinCreatedAt(date)
      expect(ratePerMin[key]).toBe(1)
    })

    it('should increment existing minute entry', () => {
      const date = Date.now()
      const key = RateUtility.nearestMinCreatedAt(date)
      const ratePerMin = { [key]: 5 }

      RateUtility.updateRatePerMin(ratePerMin, date)

      expect(ratePerMin[key]).toBe(6)
    })

    it('should remove old entries while updating', () => {
      const now = Date.now()
      const elevenMinutesAgo = now - 11 * 60 * 1000
      const ratePerMin = { [elevenMinutesAgo]: 10 }

      RateUtility.updateRatePerMin(ratePerMin, now)

      expect(ratePerMin[elevenMinutesAgo]).toBeUndefined()
    })

    it('should handle multiple updates in same minute', () => {
      const ratePerMin = {}
      const date = Date.now()

      RateUtility.updateRatePerMin(ratePerMin, date)
      RateUtility.updateRatePerMin(ratePerMin, date + 1000)
      RateUtility.updateRatePerMin(ratePerMin, date + 2000)

      const key = RateUtility.nearestMinCreatedAt(date)
      expect(ratePerMin[key]).toBe(3)
    })
  })

  describe('getRatePerMin', () => {
    it('should return rate for existing minute', () => {
      const date = Date.now()
      const key = RateUtility.nearestMinCreatedAt(date)
      const ratePerMin = { [key]: 15 }

      const result = RateUtility.getRatePerMin(ratePerMin, date)

      expect(result).toBe(15)
    })

    it('should return 0 for non-existing minute', () => {
      const ratePerMin = {}
      const date = Date.now()

      const result = RateUtility.getRatePerMin(ratePerMin, date)

      expect(result).toBe(0)
    })

    it('should return 0 for undefined ratePerMin', () => {
      const result = RateUtility.getRatePerMin(undefined, Date.now())
      expect(result).toBe(0)
    })

    it('should return 0 for null ratePerMin', () => {
      const result = RateUtility.getRatePerMin(null, Date.now())
      expect(result).toBe(0)
    })

    it('should handle different minutes correctly', () => {
      const time1 = new Date('2026-01-25T12:34:00.000Z').getTime()
      const time2 = new Date('2026-01-25T12:35:00.000Z').getTime()
      const key1 = RateUtility.nearestMinCreatedAt(time1)
      const key2 = RateUtility.nearestMinCreatedAt(time2)

      const ratePerMin = {
        [key1]: 10,
        [key2]: 20
      }

      expect(RateUtility.getRatePerMin(ratePerMin, time1)).toBe(10)
      expect(RateUtility.getRatePerMin(ratePerMin, time2)).toBe(20)
    })
  })
})
