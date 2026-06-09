'use strict';

const Homey = require('homey');
const IDMProtocol = require('../../lib/IDMProtocol');

const DISCOVERY_TIMEOUT_MS = 10000;

class IDMDriver extends Homey.Driver {

  async onInit() {
    this.log('iDotMatrix driver initialized');
  }

  async onPairListDevices() {
    this.log('Scanning for iDotMatrix BLE devices...');
    let advertisements = [];
    try {
      advertisements = await this.homey.ble.discover([IDMProtocol.SERVICE_UUID], DISCOVERY_TIMEOUT_MS);
    } catch (e) {
      this.log('Service-filtered discover failed, falling back to unfiltered scan:', e.message);
    }
    if (!advertisements.length) {
      // Some firmwares do not advertise the service UUID. Scan unfiltered, filter by name.
      try {
        advertisements = await this.homey.ble.discover([], DISCOVERY_TIMEOUT_MS);
      } catch (e) {
        this.log('Unfiltered discover failed:', e.message);
      }
    }

    const matches = advertisements.filter(adv => {
      const name = adv.localName || adv.name || '';
      return name.startsWith(IDMProtocol.NAME_PREFIX);
    });

    this.log(`Found ${matches.length} iDotMatrix device(s)`);
    return matches.map(adv => ({
      name: adv.localName || adv.name || 'iDotMatrix',
      data: { id: adv.uuid },
      store: { address: adv.address || null },
    }));
  }
}

module.exports = IDMDriver;
