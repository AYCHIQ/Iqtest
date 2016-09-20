/**
 * @param {array} arr -- array of numbers
 * @returns {number} sum
 */
function sum(arr) {
  return arr.filter(isFinite).reduce((sum, val) => sum + val, 0);
}

/**
 * Mean calculation
 * @param {array} arr -- array of numbers
 * @returns {number} mean
 */
function mean(arr) {
  if (Array.isArray(arr)) {
    return sum(arr) / arr.length;
  } else {
    return -1;
  }
}

/**
 * Maximum
 * @param {array} arr -- array of numbers
 * @returns {number}
 */
function max(arr) {
  return Math.max.apply(null, arr.filter(isFinite));
}

/**
 * Minimum
 * @param {array} arr -- array of numbers
 * @returns {number}
 */
function min(arr) {
  return Math.min.apply(null, arr.filter(isFinite));
}

/**
 * Standard deviation from mean
 * @param {array} arr -- array of numbers
 * @returns {number}
 */
function stdDev(samples) {
  if (Array.isArray(samples)) {
    const smean = mean(samples);
    const deviation = samples.map((val) => Math.pow(val - smean, 2));
    const variance = mean(deviation);
    const sd = Math.sqrt(variance);
    return sd;
  } else {
    return -1;
  }
}

/**
 * Median
 * @param {array} arr -- array of numbers
 * @return {number} median
 */
function median(array) {
  if (Array.isArray(array)) {
    let arr = array.filter(isFinite).slice();
    if (arr.length > 0) {
      arr.sort(function (a,b) { return a - b; });
      const centre = arr.length / 2;
      const mA = Math.ceil(centre);
      const mB = mA === centre ? mA + 1 : mA ;
      return (arr[mA-1] + arr[mB-1]) / 2;
    }
  }
  return -1;
}


/** Median absolute deviation
 * @param {array} arr
 * @returns {number}
 */
function mad(arr) {
  if (Array.isArray(arr)) {
    const med = median(arr);
    const medDev = arr.map(v => Math.abs(v - med));
    
    return median(medDev);
  } else {
    return -1;
  }
}

/**
 * Sigmoid function
 * @param {number} x
 * @param {number} max -- sigmoid maximum
 * @returns {number}
 */
function sigmoid(x, max) {
    const sMax = Math.min(max, 100);
    return (1 / (1 + Math.exp(-x / max)) - 0.5) * max * 2;
}

module.exports = {
  sum,
  min,
  max,
  mean,
  median,
  stdDev,
  mad,
  sigmoid,
};
