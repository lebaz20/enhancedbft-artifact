// Mock fs before requiring logger
jest.mock('fs', () => ({
  createWriteStream: jest.fn(() => ({
    write: jest.fn(),
    end: jest.fn()
  }))
}))

const logger = require('../utils/logger')

describe('Logger', () => {
  let stdoutWriteSpy
  let stderrWriteSpy

  beforeEach(() => {
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation()
    stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation()
  })

  afterEach(() => {
    stdoutWriteSpy.mockRestore()
    stderrWriteSpy.mockRestore()
  })

  describe('log', () => {
    it('should log messages', () => {
      const message = 'Test log message'
      logger.log(message)

      expect(stdoutWriteSpy).toHaveBeenCalled()
      const logCall = stdoutWriteSpy.mock.calls[0][0]
      expect(logCall).toContain('[LOG]')
      expect(logCall).toContain(message)
    })

    it('should log multiple arguments', () => {
      logger.log('Message', 'arg1', 'arg2')
      expect(stdoutWriteSpy).toHaveBeenCalled()
      const logCall = stdoutWriteSpy.mock.calls[0][0]
      expect(logCall).toContain('Message arg1 arg2')
    })

    it('should log objects', () => {
      const obj = { test: 'data' }
      logger.log(obj)
      expect(stdoutWriteSpy).toHaveBeenCalled()
    })
  })

  describe('error', () => {
    it('should log errors', () => {
      const errorMessage = 'Test error message'
      logger.error(errorMessage)

      expect(stderrWriteSpy).toHaveBeenCalled()
      const errorCall = stderrWriteSpy.mock.calls[0][0]
      expect(errorCall).toContain('[ERROR]')
      expect(errorCall).toContain(errorMessage)
    })

    it('should log error objects', () => {
      const error = new Error('Test error')
      logger.error(error)
      expect(stderrWriteSpy).toHaveBeenCalled()
    })

    it('should log multiple error arguments', () => {
      logger.error('Error:', 'detail1', 'detail2')
      expect(stderrWriteSpy).toHaveBeenCalled()
      const errorCall = stderrWriteSpy.mock.calls[0][0]
      expect(errorCall).toContain('Error: detail1 detail2')
    })
  })

  describe('warn', () => {
    it('should log warning messages', () => {
      const message = 'Warning message'
      logger.warn(message)

      expect(stdoutWriteSpy).toHaveBeenCalled()
      const logCall = stdoutWriteSpy.mock.calls[0][0]
      expect(logCall).toContain('[WARN]')
      expect(logCall).toContain(message)
    })
  })

  describe('debug', () => {
    it('should log debug messages when DEBUG is set', () => {
      process.env.DEBUG = 'true'
      const message = 'Debug message'
      logger.debug(message)

      expect(stdoutWriteSpy).toHaveBeenCalled()
      const logCall = stdoutWriteSpy.mock.calls[0][0]
      expect(logCall).toContain('[DEBUG]')
      expect(logCall).toContain(message)
      
      delete process.env.DEBUG
    })

    it('should not output to stdout when DEBUG is not set', () => {
      delete process.env.DEBUG
      stdoutWriteSpy.mockClear()
      
      logger.debug('Debug message')
      
      expect(stdoutWriteSpy).not.toHaveBeenCalled()
    })
  })
})
