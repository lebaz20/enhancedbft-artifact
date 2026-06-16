const MESSAGE_TYPE = require('../constants/message')

describe('MESSAGE_TYPE Constants', () => {
  it('should have all required message types', () => {
    expect(MESSAGE_TYPE).toBeDefined()
    expect(MESSAGE_TYPE.pre_prepare).toBe('PRE-PREPARE')
    expect(MESSAGE_TYPE.prepare).toBe('PREPARE')
    expect(MESSAGE_TYPE.commit).toBe('COMMIT')
    expect(MESSAGE_TYPE.round_change).toBe('ROUND_CHANGE')
    expect(MESSAGE_TYPE.block_to_core).toBe('BLOCK_TO_CORE')
  })

  it('should have unique values for each message type', () => {
    const values = Object.values(MESSAGE_TYPE)
    const uniqueValues = [...new Set(values)]
    expect(values.length).toBe(uniqueValues.length)
  })

  it('should use snake_case naming convention for protocol types', () => {
    expect(MESSAGE_TYPE).toHaveProperty('pre_prepare')
    expect(MESSAGE_TYPE).toHaveProperty('round_change')
    expect(MESSAGE_TYPE).toHaveProperty('block_to_core')
  })

  it('should have expected message type count', () => {
    const count = Object.keys(MESSAGE_TYPE).length
    expect(count).toBeGreaterThan(5) // At least 6 message types
  })
})
