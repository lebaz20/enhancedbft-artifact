const fs = require('fs')
const path = require('path')

class Logger {
  constructor() {
    this.logStream = fs.createWriteStream(
      path.join(process.cwd(), 'server.log'),
      { flags: 'a' }
    )
  }

  log(...args) {
    const timestamp = new Date().toISOString()
    const message = args.join(' ')
    this.logStream.write(`[LOG ${timestamp}] ${message}\n`)
    process.stdout.write(`[LOG] ${message}\n`)
  }

  error(...args) {
    const timestamp = new Date().toISOString()
    const message = args.join(' ')
    this.logStream.write(`[ERROR ${timestamp}] ${message}\n`)
    process.stderr.write(`[ERROR] ${message}\n`)
  }

  warn(...args) {
    const timestamp = new Date().toISOString()
    const message = args.join(' ')
    this.logStream.write(`[WARN ${timestamp}] ${message}\n`)
    process.stdout.write(`[WARN] ${message}\n`)
  }

  debug(...args) {
    const timestamp = new Date().toISOString()
    const message = args.join(' ')
    this.logStream.write(`[DEBUG ${timestamp}] ${message}\n`)
    if (process.env.DEBUG) {
      process.stdout.write(`[DEBUG] ${message}\n`)
    }
  }

  close() {
    this.logStream.end()
  }
}

module.exports = new Logger()
