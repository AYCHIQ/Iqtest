/**
 * Extract stream information encoded in filename
 * within RTSP URI.
 * Vendor+Name_H264_800x600_30.ts ->
 * {
 *  vendor: Vendor Name,
 *  format: H264,
 *  width: 800,
 *  height: 600,
 *  fps: 30
 * }
 * @param {string}
 * @returns {object} stream info
 */
function _parseUri(uri) {
  const locationRe = /location=([^~]+).+?!/;
  const keys = ['vendor', 'format', 'width', 'height', 'fps'];
  if (locationRe.test(uri)) {
    return locationRe.exec(uri)[1] //get "location=..." fragment
      .replace(/.+\//, '') //remove folder ".../"
      .replace(/\..*/, '') //remove extension ".*"
      .replace(/\+/g, ' ')
      .replace(/_/g, '\t')
      .replace(/(\d+)x(\d+)/g, '$1\t$2') //split WxH
      .split('\t')
      .reduce((r, val, idx) => {
          r.res[r.keys[idx]] = val;
            return r;
      }, {res: {}, keys})
      .res;
  } else {
    return {
      vendor: uri,
    };
  }
}

/**
 * Extract stream info from URI
 * @param {string} uri -- RTSP URI
 * @returns {object} stream info
 */
function parseUri(uri) {
  const keyval = uri.match(/\w+=(\w+|\d+)/g);
  const {width, height, framerate, profile, bitrate, pattern} = keyval
    .map(kv => kv.split('='))
    //overwrites duplicate keys with last occurence 
    .reduce((props, kv) => (props[kv[0]] = kv[1], props), {})
  ;

  return {
    vendor: 'GStreamer',
    format: String(/\w+(?=enc)/.exec(uri)),
    width, height, framerate,
    profile, bitrate, pattern,
  };
}

/**
 * Format last attempt report
 * @param {Experiment} e
 * @returns {string}
 */
function reportLast(e) {
  const {
    vendor, format, pattern = 'n/a', profile = 'n/a',
     width, height, framerate, bitrate = 'n/a',
  } = e.streamAttr;
  const lastAtmp = e.getAttempt(-1);
  const cpu = lastAtmp.cpu.mean.toFixed(2);
  const fps = lastAtmp.fpsIn.toFixed(2);
  const cams = lastAtmp.count;
  const sigma = -1;
  const score = -1;
  const start = e.start;
  const elapsed = e.elapsed;

  return ''
    + `${vendor}	${format}	${profile}	${pattern}	`
    + `${width}	${height}	${framerate}	${bitrate}	`
    + `${fps}	${cams}	${sigma}	${cpu}	`
    + `${score}	${start}	${elapsed}\n`;
}

/**
 * Format experiment report
 * @param {Experiment} e
 * @returns {string}
 */
function report(e) {
  const {
    vendor, format, pattern = 'n/a', profile = 'n/a',
     width, height, framerate, bitrate = 'n/a',
  } = e.streamAttr;
  const cpu = e.cpu.toFixed(2);
  const fps = e.fps.toFixed(2);
  const cams = e.cams;
  const sigma = e.camsDispersion.toFixed(2);
  const score = e.score.toFixed(2);
  const start = e.start;
  const elapsed = e.elapsed;

  return ''
    + `${vendor}	${format}	${profile}	${pattern}	`
    + `${width}	${height}	${framerate}	${bitrate}	`
    + `${fps}	${cams}	${sigma}	${cpu}	`
    + `${score}	${start}	${elapsed}\n`;
}

/**
 * Extract id from message id string
 * @param {string} msgId -- message id string (e.g. [MONITOR][1][CAM][10][OUT])
 * @returns {string} id
 */
function getId(msgId) {
  return /([0-9]+)[^0-9]*$/.exec(msgId)[1];
}

/**
 * Make debounced function
 * @param {function} fn -- function to call
 * @param {number} delay -- delay in ms
 * @returns {function}
 */
function debounce(fn, delay) {
  let timerId = null;
  return function () {
    clearTimeout(timerId);
    timerId = setTimeout((args) => fn.apply(null, args), delay, arguments);
  }
};

/**
 * Make throttled function
 * @param {function} fn -- function to call
 * @param {number} delay -- timeout in ms
 * @returns {function
 */ 
function throttle(fn, delay) {
  let canRun = true;
  const resetFlag = () => canRun = true;

  return function () {
    if (canRun) {
      canRun = false;
      setTimeout(resetFlag, delay);
      fn.apply(null, arguments);
    }
  }
}

module.exports = {
  parseUri,
  report,
  reportLast,
  getId,
  debounce,
  throttle,
};
