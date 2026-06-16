/* eslint-disable camelcase */
const MESSAGE_TYPE = {
  transaction: 'TRANSACTION',
  prepare: 'PREPARE',
  pre_prepare: 'PRE-PREPARE',
  commit: 'COMMIT',
  round_change: 'ROUND_CHANGE',
  view_change: 'VIEW_CHANGE',
  block_to_core: 'BLOCK_TO_CORE',
  committee_block_to_core: 'COMMITTEE_BLOCK_TO_CORE',
  block_from_core: 'BLOCK_FROM_CORE',
  rate_to_core: 'RATE_TO_CORE',
  config_from_core: 'CONFIG_FROM_CORE'
}

module.exports = MESSAGE_TYPE
/* eslint-enable camelcase */
