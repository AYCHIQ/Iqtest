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
 * @params {string}
 * returns {object}
 */
function parseUri(uri) {
  const locationRe = /location=([^`]+).+?!/;
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
 * Format experiment report
 * @param {Experiment} e
 * @returns {string}
 */
function report(e) {
  const s = e.streamAttr;
  const vendor = s.vendor;
  const format = s.format;
  const width = s.width;
  const height = s.height;
  const sfps = s.fps;
  const cpu = e.cpu.toFixed(2);
  const fps = e.fps.toFixed(2);
  const cams = e.cams;
  const sigma = e.camsDispersion.toFixed(2);
  const score = e.score.toFixed(2);
  const start = e.start;
  const elapsed = e.elapsed;

  return `${vendor}\t${format}\t${width}\t${height}\t` +
    `${sfps}\t${fps}\t${cams}\t${sigma}\t${cpu}\t` +
    `${score}\t${start}\t${elapsed}\n`;
}

/**
 * Extract id from message id string
 * @param {string} msgId -- message id string (e.g. [MONITOR][1][CAM][10][OUT])
 * @returns {string} id
 */
function getId(msgId) {
  return /([0-9]+)[^0-9]*$/.exec(msgId)[1];
}

module.exports = {
  parseUri,
  report,
  getId,
};
