const fs = require('fs')
const config = require('../config')
const { CPU_LIMIT } = config.get()

const readCgroupCPUPercentPromise = (interval = 1000) => {
  const usagePathV1 = '/sys/fs/cgroup/cpuacct/cpuacct.usage'
  const usagePathV2 = '/sys/fs/cgroup/cpu.stat'
  let usagePath
  let isV2 = false
  if (fs.existsSync(usagePathV1)) {
    usagePath = usagePathV1
  } else if (fs.existsSync(usagePathV2)) {
    usagePath = usagePathV2
    isV2 = true
  } else {
    return Promise.reject(new Error('No cgroup CPU usage file found'))
  }

  function getUsage(path, v2) {
    const content = fs.readFileSync(path, 'utf8')
    if (v2) {
      // Find usage_usec value and convert to nanoseconds
      const match = content.match(/usage_usec (\d+)/)
      if (match) {
        return parseInt(match[1], 10) * 1000
      }
      throw new Error('usage_usec not found in cpu.stat')
    } else {
      return parseInt(content.trim(), 10)
    }
  }

  return new Promise((resolve, reject) => {
    let startUsage
    let startTime
    try {
      startUsage = getUsage(usagePath, isV2)
      startTime = process.hrtime.bigint()
    } catch (error) {
      console.error('Error reading cgroup cpu usage:', error)
      return reject(
        new Error(`Error reading cgroup cpu usage: ${error.message}`)
      )
    }

    setTimeout(() => {
      try {
        const endUsage = getUsage(usagePath, isV2)
        const endTime = process.hrtime.bigint()

        const cpuUsed = endUsage - startUsage // nanoseconds
        const wallClock = Number(endTime - startTime) // nanoseconds
        const percent = wallClock > 0 ? (cpuUsed / wallClock) * 100 : 0

        // Read CPU limit from cgroup (if available)
        let cpuLimit = Number(CPU_LIMIT)
        const cpuLimitPathV1 = '/sys/fs/cgroup/cpuacct/cpu.cfs_quota_us'
        const cpuPeriodPathV1 = '/sys/fs/cgroup/cpuacct/cpu.cfs_period_us'
        const cpuLimitPathV2 = '/sys/fs/cgroup/cpu.max'

        if (fs.existsSync(cpuLimitPathV1) && fs.existsSync(cpuPeriodPathV1)) {
          const quota = parseInt(
            fs.readFileSync(cpuLimitPathV1, 'utf8').trim(),
            10
          )
          const period = parseInt(
            fs.readFileSync(cpuPeriodPathV1, 'utf8').trim(),
            10
          )
          if (quota > 0 && period > 0) {
            cpuLimit = quota / period
          }
        } else if (fs.existsSync(cpuLimitPathV2)) {
          const cpuMax = fs.readFileSync(cpuLimitPathV2, 'utf8').trim()
          const [quotaString, periodString] = cpuMax.split(' ')
          const quota = quotaString === 'max' ? -1 : parseInt(quotaString, 10)
          const period = parseInt(periodString, 10)
          if (quota > 0 && period > 0) {
            cpuLimit = quota / period
          }
        }

        // Calculate percentage of CPU limit used
        let cpuPercentOfLimit = percent
        if (cpuLimit > 0) {
          cpuPercentOfLimit = (
            ((parseFloat(percent) / 100) * 100) /
            cpuLimit
          ).toFixed(2)
        }

        resolve(Number(cpuPercentOfLimit)) // returns percentage as number
      } catch (error) {
        console.error('Error reading cgroup cpu usage:', error)
        reject(new Error(`Error reading cgroup cpu usage: ${error.message}`))
      }
    }, interval)
  })
}

module.exports = { readCgroupCPUPercentPromise }
