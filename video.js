'use strict';
const IqClient = require('iq-node').Client;
const video = new IqClient(); 

const GRABPARAMS = {
  _TRANSPORT_ID: '',
  auth: '',
  brand: '',
  chan: 0,
  codec: '',
  drives: '',
  flags: '',
  format: 'PAL',
  int_obj_id: 1,
  ip: '',
  ip_port: 80,
  mode: 1,
  model: '',
  name: '',
  objname: '',
  parent_id: '',
  password: '',
  resolution: '',
  type: 'RTSP',
  useconfigurebyweb: 1,
  user: '',
  username: '',
  watchdog: 0,
};
const CAMPARAMS = {
  'AUDIO.mic_id.count': 0,
  _TRANSPORT_ID: '',
  activity: '',
  additional_info: '',
  alarm_rec: 1,
  arch_days: 0,
  armed: 0,
  audio_type: '',
  blinding: 0,
  bosch_ptz_protocol: '',
  bright: 5,
  bt: 0,
  color: 1,
  compression: 2,
  compressor: '',
  config_id: '',
  config_id: '',
  contrast: 5,
  decoder: 0,
  decompressor: '',
  disabled: 0,
  flags: '',
  fps: 0,
  hot_rec_period: 0,
  hot_rec_time: 0,
  ifreg: 8,
  int_obj_id: '',
  manual: 1,
  mask0: '',
  mask1: '',
  mask2: '',
  mask3: '',
  mask4: '',
  mask: '',
  md_contrast: 8,
  md_mode: 0,
  md_size: 5,
  motion: 7,
  multistreaming_mode: 0,
  mux: 0,
  name: '',
  objid: '',
  objname: '',
  parent_id: '',
  password_crc: '',
  pre_rec_time: 0,
  priority: '',
  proc_time: 0,
  rec_priority: 0,
  region_id: '',
  resolution: 0,
  rotate: 0,
  rotateAngle: 0,
  sat_u: 5,
  source_folder: '',
  stream_alarm: '',
  stream_analitic: '',
  stream_archive: '',
  stream_client: '',
  telemetry_id: '',
  type: '',
  yuv: '',
};
const MONITORPARAMS = {
  'CAM.arch.count': '0',
  'CAM.cam.count': '0',
  'CAM.compression.count': '0',
  'CAM.compressor.count': '0',
  'CAM.direct_connect.count': '0',
  'CAM.gate.count': '0',
  'CAM.gate_arch.count': '0',
  'CAM.gstream_version.count': '0',
  'CAM.guid.count': '0',
  'CAM.ipstorage.count': '0',
  'CAM.speed.count': '0',
  'CAM.stream_id.count': '0',
  __slave_id: '',
  allow_arch_hours: '2147483647',
  allow_archop_hours: '2147483647',
  allow_delete_files: '',
  allow_export_files: '1',
  allow_move: '',
  allow_protect_files: '1',
  allow_unprotect_files: '1',
  antialiasing: '0',
  arch_id: '',
  check_rights: '0',
  cycle: '',
  enable: '1',
  flags: '',
  from_last_logon: '0',
  from_last_logon_op: '0',
  h: '100',
  inited_slave_id: '',
  max_cams: '',
  min_cams: '',
  monitor: '0',
  monitor_ch: '',
  monitor_cw: '',
  name: '',
  objname: '',
  overlay: '2',
  panel: '1',
  parent_id: '',
  player_id: '',
  show_titles: '1',
  speaker_id: '',
  tel_prior: '1',
  telemetry: '',
  type: '',
  w: '100',
  x: '0',
  y: '0',
};

module.exports = {
  connect(options) {
    this.host = options.host;
    return video.connect(Object.assign({port: 'video'}, options));
  },
  stats(interval) {
    video.on({type: 'IQ', action: 'CONNECTED'},
      () => video.sendReact({
        type: 'STATISTIC',
        action: 'START',
        params: {
          interval: interval || 1,
          slave_id: this.host,
        }
      }));
  },
  statsStop() {
    video.sendReact({
      type: 'STATISTIC',
      action: 'STOP',
      params: {
        slave_id: this.host,
      }
    });
  },
  requestStats() {
    video.sendReact({
      type: 'STATISTIC',
      action: 'GET',
      params: {
        slave_id: this.host,
      }
    });
  },
  onstats(fn) {
    video.on({type: 'STATISTIC', action: 'SET'}, fn);
  },
  offstats() {
    video.off({type: 'STATISTIC', action: 'SET'});
  },
  onconnect(fn) {
    video.on({type: 'IQ', action: 'CONNECTED'}, () => {
      fn();
    });
  },
  ondisconnect(fn) {
    video.on({type: 'IQ', action: 'DISCONNECTED'}, () => {
      fn();
    });
  },
  deleteObjs(type, id) {
    video.sendReact({
      type,
      id: id || '',
      action: 'DELETE',
    });
  },
  setupMonitor(id, params) {
    const name = `Monitor ${id}`;
    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'SETUP',
      params: Object.assign({}, MONITORPARAMS, {
        __slave_id: this.host,
        inited_slave_id: this.host,
        name,
        objname: name,
      })
    });

    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'ACTIVATE',
    });
  },
  deleteMonitor(id) {
    this.clearMonitor(id);
    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'DEACTIVATE',
    });
  },
  clearMonitor(id) {
    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'REMOVE_ALL',
    });
  },
  setupIpCam(id, address, opts) {
    const name = `Cam ${id}`;
    video.sendReact({
      type: 'GRABBER',
      id,
      action: 'SETUP',
      params: Object.assign({}, GRABPARAMS, {
        ip: address,
        int_obj_id: id,
        parent_id: this.host,
        name,
        objname: name,
      }, opts)
    });
    video.sendReact({
      type: 'CAM',
      id,
      action: 'SETUP',
      params: Object.assign({}, CAMPARAMS, {
        int_obj_id: id,
        parent_id: id,
        name,
        objname: name,
      })
    });
    video.sendReact({
      type: 'CAM',
      id,
      action: 'REC',
    });
  },
  removeIpCam(id) {
    video.sendReact({
      type: 'GRABBER',
      id,
      action: 'DELETE',
    });
  },
  showCam(cam, id) {
    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'ADD_SHOW',
      params: {
        cam,
        slave_id: this.host,
  //       stream_id: cam + '.1',
      }
    });
  },
  hideCam(cam, id) {
    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'REMOVE',
      params: {
        cam,
        slave_id: this.host,
  //       stream_id: cam + '.1',
      }
    });
  },
  startVideo(cam, id) {
    video.sendReact({
      type: 'CAM',
      id: cam,
      action: 'START_VIDEO',
      params: {
        slave_id: `${this.host}.${id}`,
      },
    });
  },
};
