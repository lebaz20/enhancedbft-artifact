const TEN_MINUTES = 10 * 60 * 1000;

class RateUtility {
  // a static function to return the nearest minute (in ms)
  static nearestMinCreatedAt(date = Date.now()) {
    return Math.floor(date / 60000) * 60000;
  }

  // a static function to return the nearest previous minute (in ms)
  static getPreviousMinute() {
    const date = new Date();
    date.setSeconds(0, 0);
    date.setMinutes(date.getMinutes() - 1);
    return date.getTime();
  }

  // a static function to remove entries older than 10 minutes
  static removeOlderEntries(ratePerMin) {
    const now = Date.now();
    Object.keys(ratePerMin).forEach((key) => {
      if (now - Number(key) > TEN_MINUTES) {
        delete ratePerMin[key];
      }
    });
  }

  // a static function to update ratePerMin
  static updateRatePerMin(ratePerMin, date) {
    const nearestMinCreatedAt = RateUtility.nearestMinCreatedAt(date);
    if (!ratePerMin[nearestMinCreatedAt]) {
      ratePerMin[nearestMinCreatedAt] = 1;
    } else {
      ratePerMin[nearestMinCreatedAt]++;
    }
    RateUtility.removeOlderEntries(ratePerMin);
  }

  // a static function to get ratePerMin
  static getRatePerMin(ratePerMin, date) {
    const nearestMinCreatedAt = RateUtility.nearestMinCreatedAt(date);
    return ratePerMin && nearestMinCreatedAt in ratePerMin
      ? ratePerMin[nearestMinCreatedAt]
      : 0;
  }
}

module.exports = RateUtility;
