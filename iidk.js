'use strict';
const iidk = require('iq-node');
const TIMEOUT = 30000;
const KEEPALIVE = 30000;

iidk.on({type: 'IQ', action: 'DISCONNECTED'}, () => {
  process.stderr.write('IIDK disconnected\n');  
});
iidk.on({type: 'IQ', action: 'CONNECTED'}, () => {
  process.stderr.write('IIDK connected\n');  
});

module.exports = {
  keepAliveTimer: null,
  resetKATimer() {
    clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = setTimeout(() =>
        iidk.sendEvent({type: 'ACTIVEX', action: 'GET_LIST'}), KEEPALIVE);
  },
  connect(options) {
    this.host = options.host;
    return iidk.connect(Object.assign({port: 'iidk'}, options))
      .then(this.resetKATimer.bind(this));
  },
  restartModules() {
    iidk.sendEvent({
      type: 'SLAVE',
      id: this.host,
      action: 'RUN_SLAVES',
    });
    this.resetKATimer();
  },
  startModule(module) {
    const startReact = {
      type: 'SLAVE',
      id: this.host,
      action: 'EXECUTE_SET',
      params: {
        command: module,
      }
    };
    const executeComplete = {type: 'SLAVE', action: 'EXECUTE_COMPLETE'};
    const timer = setInterval(() => iidk.sendCoreReact(startReact), TIMEOUT);
    return new Promise((resolve, reject) => {
      iidk.on(executeComplete, (msg) => {
        if (msg.params.command.includes(module)) {
          clearInterval(timer);
          iidk.off(executeComplete);
          resolve();
        }
      });
      iidk.sendCoreReact(startReact);
      this.resetKATimer();
    });
  },
  stopModule(module) {
    const stopReact = {
      type: 'SLAVE',
      id: this.host,
      action: 'TERMINATE_SET',
      params: {
        command: module,
      }
    };
    const terminateComplete = {type: 'SLAVE', action: 'TERMINATE_COMPLETE'};
    const timer = setInterval(() => iidk.sendCoreReact(stopReact), TIMEOUT);
    return new Promise((resolve, reject) => {
      iidk.on(terminateComplete, (msg) => {
        if (msg.params.command.includes(module)) {
          clearInterval(timer);
          iidk.off(terminateComplete);
          resolve();
        }
      });
      iidk.sendCoreReact(stopReact);
      this.resetKATimer();
    });
  },
  updateObj(objtype, objid, settings) {
    let params = Object.assign(settings, {
      objtype,
      objid,
    });
    iidk.sendEvent({
      type: 'CORE',
      action: 'UPDATE_OBJECT',
      params,
    });
    this.resetKATimer();
  },
};
